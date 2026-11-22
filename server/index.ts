import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'tapeleaf',
    phase: 1,
  }),
);

export { app };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const port = Number(process.env.PORT ?? 3001);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Tapeleaf server listening on http://127.0.0.1:${info.port}`);
  });
}
