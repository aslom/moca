import { main } from './cli.js';
import { loginHelpers } from './os.js';

const ac = new AbortController();

/** All of stdin, or (with `limit`) the first `limit` bytes or more: the reading stops there. */
async function readStdinBytes(limit = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
    n += (chunk as Buffer).length;
    if (n >= limit) break;
  }
  return Buffer.concat(chunks);
}
process.once('SIGINT', () => ac.abort());

const code = await main(
  process.argv.slice(2),
  process.env,
  {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s + '\n'),
    outBytes: (b) => void process.stdout.write(b),
    errBytes: (b) => void process.stderr.write(b),
  },
  {
    signal: ac.signal,
    stdinIsTTY: process.stdin.isTTY === true,
    readStdin: async () => (await readStdinBytes()).toString('utf8'),
    readStdinBytes,
    loginHelpers: loginHelpers(process.env, {
      stdin: process.stdin.isTTY === true,
      stderr: process.stderr.isTTY === true,
    }),
    // Loaded lazily so the headless commands never load Ink or React.
    startInteractive: async (rt, opts) => (await import('./start.js')).startInteractive(rt, opts),
  },
);
// After a Ctrl-C, a listing or a stdin read may still be pending (they are abandoned, not
// stopped), and either would keep the process alive; exit once stdout has drained.
if (ac.signal.aborted) process.stdout.write('', () => process.exit(code));
else process.exitCode = code;
