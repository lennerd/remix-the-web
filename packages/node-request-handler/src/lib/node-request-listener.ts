import * as http from 'node:http';

import { RequestHandler, ErrorHandler } from './request-handler.js';
import { getRequestUrl } from './request-url.js';
import { TrustArg, createTrustProxy } from './trust-proxy.js';

export interface RequestListenerOptions {
  /**
   * An error handler that determines the response when the request handler throws an error. By
   * default a 500 Internal Server Error response will be sent.
   */
  onError?: ErrorHandler;
  /**
   * Determines if/how the `X-Forwarded-Proto` and `X-Forwarded-Host` headers should be used to
   * derive the request URL. By default these headers are not trusted because they can easily be
   * spoofed. But if you're running behind a reverse proxy, you may use this option to allow them
   * to be trusted.
   *
   * To trust a specific server, pass the IP address of the server as a string:
   *
   * ```ts
   * createRequestListener(handler, { trustProxy: '127.0.0.1' })
   * ```
   *
   * To trust a list of servers, pass their addresses in a comma-separated list or an array:
   *
   * ```ts
   * createRequestListener(handler, { trustProxy: '127.0.0.1, 169.254.0.0' })
   * createRequestListener(handler, { trustProxy: ['127.0.0.1', '169.254.0.0'] })
   * ```
   *
   * Use a subnet mask to trust a range of servers:
   *
   * ```ts
   * // Trust any server on the 127.0.0.x subnet
   * createRequestListener(handler, { trustProxy: '127.0.0.0/8' })
   * ```
   *
   * To trust all proxy servers, pass `true`.
   *
   * ```ts
   * createRequestListener(handler, { trustProxy: true })
   * ```
   */
  trustProxy?: boolean | TrustArg;
}

/**
 * Wraps a `RequestHandler` function in a Node.js `http.RequestListener` that can be used with
 * `http.createServer()` or `https.createServer()`.
 *
 * ```ts
 * import * as http from 'node:http';
 * import { RequestHandler, createRequestListener } from '@mjackson/node-request-handler';
 *
 * let handler: RequestHandler = async (request) => {
 *   return new Response('Hello, world!');
 * };
 *
 * let server = http.createServer(
 *   createRequestListener(handler)
 * );
 *
 * server.listen(3000);
 * ```
 */
export function createRequestListener(
  handler: RequestHandler,
  options?: RequestListenerOptions,
): http.RequestListener {
  let onError = options?.onError ?? defaultErrorHandler;
  let trustProxy = createTrustProxy(options?.trustProxy);

  return async (req, res) => {
    let controller = new AbortController();
    res.on('close', () => {
      controller.abort();
    });

    let url = getRequestUrl(req, trustProxy);
    let request = createRequest(req, url, controller.signal);

    try {
      let response = await handler(request);
      await sendResponse(res, response);
    } catch (error) {
      try {
        let response = await onError(error);
        await sendResponse(res, response ?? internalServerError());
      } catch (error) {
        console.error(`There was an error in the error handler: ${error}`);
        await sendResponse(res, internalServerError());
      }
    }
  };
}

function defaultErrorHandler(error: unknown): Response {
  console.error(error);
  return internalServerError();
}

function internalServerError(): Response {
  return new Response('Internal Server Error', {
    status: 500,
    headers: {
      'Content-Type': 'text/plain',
    },
  });
}

function createRequest(req: http.IncomingMessage, url: URL, signal: AbortSignal): Request {
  let init: RequestInit = {
    method: req.method,
    headers: createHeaders(req.headers),
    signal,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = createBody(req);

    // init.duplex = 'half' must be set when body is a ReadableStream, and Node follows the spec.
    // However, this property is not defined in the TypeScript types for RequestInit, so we have
    // to cast it here in order to set it without a type error.
    // See https://fetch.spec.whatwg.org/#dom-requestinit-duplex
    (init as { duplex: 'half' }).duplex = 'half';
  }

  return new Request(url, init);
}

function createHeaders(incoming: http.IncomingHttpHeaders): Headers {
  let headers = new Headers();

  for (let key in incoming) {
    let value = incoming[key];

    if (Array.isArray(value)) {
      for (let v of value) {
        headers.append(key, v);
      }
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  return headers;
}

function createBody(req: http.IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      req.on('data', (chunk) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });

      req.on('end', () => {
        controller.close();
      });
    },
  });
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  for (let [name, value] of response.headers.entries()) {
    res.setHeader(name, value);
  }

  if (isEventStreamResponse(response)) {
    res.flushHeaders();
  }

  if (response.body) {
    for await (let chunk of response.body) {
      res.write(chunk);
    }
  }

  res.end();
}

function isEventStreamResponse(response: Response): boolean {
  let contentType = response.headers.get('Content-Type');
  return contentType?.startsWith('text/event-stream') ?? false;
}
