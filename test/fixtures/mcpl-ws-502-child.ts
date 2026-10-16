import http from 'node:http';
import { McplServerConnection } from '../../node_modules/@animalabs/agent-framework/src/mcpl/server-connection.ts';

const server = http.createServer((_req, response) => {
  response.writeHead(502);
  response.end('backend unavailable');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('expected TCP address');

try {
  await McplServerConnection.connect(
    { id: 'unavailable', url: `ws://127.0.0.1:${address.port}/mcpl` },
    { version: '0.4', pushEvents: true, featureSets: true },
  );
} catch {
  // The dial is expected to reject. The regression is a second, late raw
  // socket error escaping after cleanup and changing the process exit code.
}

await new Promise((resolve) => setTimeout(resolve, 100));
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log('SURVIVED');
