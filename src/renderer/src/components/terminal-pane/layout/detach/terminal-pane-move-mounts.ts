import type {
  SourcePaneBinding,
  TerminalPaneTabDetachManager
} from './terminal-pane-tab-detach-steps'

/** A terminal tab's live mount: its pane manager and how to read a pane's binding in it. */
export type TerminalPaneMoveMount = {
  manager: TerminalPaneTabDetachManager
  readPane: (paneId: number) => SourcePaneBinding
}

type MountReader = () => TerminalPaneMoveMount | null

const mountsByTab = new Map<string, MountReader>()

function tabKey(worktreeId: string, tabId: string): string {
  return `${worktreeId}\0${tabId}`
}

/**
 * Registers the mount that now draws a tab. A move outlives the component that started it (a
 * parked tab is unmounted and a revealed one remounts), so it reads its tab through here.
 */
export function registerTerminalPaneMoveMount(
  worktreeId: string,
  tabId: string,
  read: MountReader
): () => void {
  const key = tabKey(worktreeId, tabId)
  mountsByTab.set(key, read)
  return () => {
    // React can mount a replacement before the old effect cleans up.
    if (mountsByTab.get(key) === read) {
      mountsByTab.delete(key)
    }
  }
}

export function currentTerminalPaneMoveMount(
  worktreeId: string,
  tabId: string
): TerminalPaneMoveMount | null {
  return mountsByTab.get(tabKey(worktreeId, tabId))?.() ?? null
}
