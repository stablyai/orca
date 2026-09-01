const PREFIX = '--orca-browser-client-host-id='

/**
 * How main hands a renderer the id it hosts browser guests under: a command-line argument, read
 * from the preload's own argv.
 *
 * Why not a synchronous IPC read, which is the obvious shape for an answer the renderer needs
 * before it interprets its first session snapshot: Electron never replies to a `sendSync` that
 * lands before its listener is registered — it logs a warning and leaves the renderer blocked for
 * the life of the process, and registering the listener afterwards does not release it (measured
 * on Electron 43). An argument is on the renderer since birth and costs a string scan.
 */
export function formatBrowserClientHostIdArgument(browserHostClientId: string): string {
  return `${PREFIX}${browserHostClientId}`
}

/** Null for every renderer main did not stamp — the web client, and any guest we hand nothing. */
export function readBrowserClientHostIdArgument(argv: readonly string[]): string | null {
  for (const argument of argv) {
    if (argument.startsWith(PREFIX)) {
      return argument.slice(PREFIX.length) || null
    }
  }
  return null
}
