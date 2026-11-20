import type { IncomingMessage, ServerResponse } from 'http';
import { createApiApp } from '../src/server/app';

const apiApp = createApiApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const vercelReq = req as IncomingMessage & { body?: unknown; _body?: boolean };
  // Vercel pre-parses JSON bodies before invoking serverless handlers; mark _body so express.json() skips re-reading the drained stream
  if (vercelReq.body !== undefined) {
    vercelReq._body = true;
  }

  if (req.url && !req.url.startsWith('/api')) {
    req.url = `/api${req.url.startsWith('/') ? '' : '/'}${req.url}`;
  }

  return apiApp(req as Parameters<typeof apiApp>[0], res as Parameters<typeof apiApp>[1]);
}
