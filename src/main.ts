import { createApp } from './app.js';
import { config } from './config.js';
const { app, db } = await createApp();
let closing: Promise<void> | undefined;
const close = () => (closing ??= app.close().finally(() => db.close()));
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    void close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
try {
  await app.listen(config.port, config.host);
  console.log(`Pidan Vocal API listening on ${config.host}:${config.port}`);
} catch (error) {
  await close();
  throw error;
}
