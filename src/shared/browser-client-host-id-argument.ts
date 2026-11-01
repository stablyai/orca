const PREFIX = '--orca-browser-client-host-id='

/** Pass host identity in renderer argv from birth. Electron 43 sendSync before listener registration blocks forever even after registration; startup snapshots need this before any IPC dependency. */
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
