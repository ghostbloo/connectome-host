import { createWriteStream } from "node:fs";
import path from "node:path";

export interface HeadlessLogConfig {
  transport: 'file' | 'stdout';
  /** Path to directory where headless.log will be created, for file transport. Default is DATA_DIR. */
  dir?: string;
}

export interface HeadlessLog {
  log: (msg: string) => void;
  onShutdown?: () => Promise<void>;
}

export async function setupHeadlessLog(config: HeadlessLogConfig): Promise<HeadlessLog> {
  if (config.transport === 'file' && config.dir) {
    const logFile = path.join(config.dir, 'headless.log');

    // -- Redirect stdout/stderr BEFORE anything else may log --
    // The IPC socket is the only structured output channel; stdout/stderr
    // become a debug log on disk.  Done first so any later console.log from
    // framework code lands in the file, not on a parent's pipe.
    //
    // Match the real process.stdout.write overload signature so libraries
    // passing (chunk, cb) or (chunk, encoding, cb) for backpressure /
    // flush confirmation don't have their callbacks silently swallowed.
    const logStream = createWriteStream(logFile, { flags: 'a' });
    type StdWrite = typeof process.stdout.write;
    const makeRedirect = (): StdWrite => {
      const redirect = function (
        this: unknown,
        chunk: string | Uint8Array,
        encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
        cb?: (err?: Error | null) => void,
      ): boolean {
        if (typeof encodingOrCb === 'function') {
          return logStream.write(chunk, encodingOrCb);
        }
        if (encodingOrCb !== undefined) {
          return logStream.write(chunk, encodingOrCb, cb);
        }
        return logStream.write(chunk);
      } as StdWrite;
      return redirect;
    };
    process.stdout.write = makeRedirect();
    process.stderr.write = makeRedirect();

    return {
      log: (msg: string): void => {
        logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
      },
      onShutdown: async () => {
        // WriteStream.end() flushes and closes; the caller waits ~50ms before exit.
        logStream.end();
      },
    };
  } else {
    // No redirect: stdout/stderr stay whatever the supervisor gave the
    // process (journald, launchd's StandardOutPath, a terminal). The host's
    // own lines become JSON so they're queryable next to the rest.
    return {
      log: (msg: string): void => {
        process.stdout.write(`${JSON.stringify({ logger: 'headless', ts: new Date().toISOString(), msg })}\n`);
      },
    };
  }
}
