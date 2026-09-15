import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

export function toPublicPane(pane: ManagedPaneInternal): ManagedPane {
  return {
    id: pane.id,
    leafId: pane.leafId,
    stablePaneId: pane.stablePaneId,
    terminal: pane.terminal,
    container: pane.container,
    linkTooltip: pane.linkTooltip,
    fitAddon: pane.fitAddon,
    searchAddon: pane.searchAddon,
    serializeAddon: pane.serializeAddon,
    // Why a getter: the inline-image addon attaches after the chunk resolves,
    // so a view handed out earlier (onPaneCreated, a retained getActivePane
    // result) must still observe the addon once it exists.
    get imageAddon() {
      return pane.imageAddon ?? null
    }
  }
}

export function collectPublicPanes(
  panes: Map<number, ManagedPaneInternal>,
  limit: number
): ManagedPane[] {
  const collected: ManagedPane[] = []
  for (const pane of panes.values()) {
    if (collected.length >= limit) {
      break
    }
    collected.push(toPublicPane(pane))
  }
  return collected
}
