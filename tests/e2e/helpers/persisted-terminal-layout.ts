import { readFileSync } from 'node:fs'

export type PersistedTerminalLayout = {
  /** Which persisted partition held the tab: `'local'` or the `ssh:<target>` host key. */
  partition: string
  root: unknown
  ptyIdsByLeafId: Record<string, string>
}

/**
 * Terminal layouts live in one of two partitions: `workspaceSession` for the local execution
 * host, `workspaceSessionsByHostId[hostId]` for every remote one. Reading the wrong one yields
 * `null` forever, which silently turns layout assertions into tautologies — so search both and
 * report which one answered.
 */
export function readPersistedTerminalLayout(
  dataFilePath: string,
  tabId: string
): PersistedTerminalLayout | null {
  const raw = JSON.parse(readFileSync(dataFilePath, 'utf8'))
  const partitions: [string, unknown][] = [
    ['local', raw.workspaceSession],
    ...Object.entries(raw.workspaceSessionsByHostId ?? {})
  ]
  for (const [partition, session] of partitions) {
    const layout = (session as { terminalLayoutsByTabId?: Record<string, unknown> } | undefined)
      ?.terminalLayoutsByTabId?.[tabId]
    if (!layout) {
      continue
    }
    const typed = layout as { root?: unknown; ptyIdsByLeafId?: Record<string, string> }
    return {
      partition,
      root: typed.root ?? null,
      ptyIdsByLeafId: typed.ptyIdsByLeafId ?? {}
    }
  }
  return null
}
