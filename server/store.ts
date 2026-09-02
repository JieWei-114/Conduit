/**
 * File-backed key/value store so the UI's settings (connections, form, history,
 * pins…) survive a browser cache clear and live in one visible file.
 *
 *   GET    /api/store  → the whole blob (or {} if none)
 *   PUT    /api/store  → overwrite the blob
 *   DELETE /api/store  → wipe it (delete the file)
 *
 * File: CONDUIT_DATA env, else conduit-data.json in the cwd (the repo root in
 * dev; the Electron app sets CONDUIT_DATA to its userData dir). It's git-ignored.
 */
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.CONDUIT_DATA ?? path.join(process.cwd(), 'conduit-data.json');

export const storeRoutes = new Hono();

storeRoutes.get('/', (c) => {
  try {
    return c.json(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return c.json({});
  }
});

storeRoutes.put('/', async (c) => {
  try {
    const body = await c.req.json();
    fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
    return c.json({ ok: true, file: FILE });
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message ?? e) }, 500);
  }
});

storeRoutes.delete('/', (c) => {
  try {
    fs.rmSync(FILE, { force: true });
  } catch {
    /* already gone */
  }
  return c.json({ ok: true });
});
