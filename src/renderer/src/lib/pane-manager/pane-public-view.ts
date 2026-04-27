import type { ManagedPane, ManagedPaneInternal } from './pane-manager-types'

export function toPublicPane(pane: ManagedPaneInternal): ManagedPane {
  return {
    id: pane.id,
    terminal: pane.terminal,
    container: pane.container,
    linkTooltip: pane.linkTooltip,
    fitAddon: pane.fitAddon,
    searchAddon: pane.searchAddon,
    serializeAddon: pane.serializeAddon
  }
}
