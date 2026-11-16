import { createServer } from 'node:net'

// Kernels assign listen(0) and outgoing ports from 32768+ (Linux) or 49152+ (macOS, Windows). A port
// taken from there and released could be handed to the relaunched app's own inspector before serve binds it.
const PINNED_PORT_MIN = 20_000
const PINNED_PORT_MAX = 32_767

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    // EADDRINUSE, or EACCES inside a Windows excluded port range.
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

/** A free port a server keeps across relaunches, outside the range the OS hands out meanwhile. */
export async function pickPinnedPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port =
      PINNED_PORT_MIN + Math.floor(Math.random() * (PINNED_PORT_MAX - PINNED_PORT_MIN + 1))
    if ((await canBind(port, '127.0.0.1')) && (await canBind(port, '0.0.0.0'))) {
      return port
    }
  }
  throw new Error(`No free port between ${PINNED_PORT_MIN} and ${PINNED_PORT_MAX}`)
}
