import type { PinnedTerminalPanel } from '../../../../shared/types'

/** Shared by the add row, the edit row, and the row list so every host and
 *  group input offers the same suggestions. */
export const HOST_DATALIST_ID = 'pinned-terminal-panel-ssh-hosts'
export const GROUP_DATALIST_ID = 'pinned-terminal-panel-groups'

export type PanelDraft = {
  title: string
  command: string
  host: string
  group: string
}

export const emptyDraft: PanelDraft = { title: '', command: '', host: '', group: '' }

export function draftFromPanel(panel: PinnedTerminalPanel): PanelDraft {
  return {
    title: panel.title,
    command: panel.command,
    host: panel.host ?? '',
    group: panel.group ?? ''
  }
}

export function panelFromDraft(
  draft: PanelDraft,
  base: Pick<PinnedTerminalPanel, 'id' | 'enabled'>
): PinnedTerminalPanel {
  const trimmedHost = draft.host.trim()
  const trimmedGroup = draft.group.trim()
  return {
    id: base.id,
    title: draft.title.trim(),
    command: draft.command.trim(),
    ...(trimmedHost.length > 0 ? { host: trimmedHost } : {}),
    ...(trimmedGroup.length > 0 ? { group: trimmedGroup } : {}),
    ...(base.enabled === false ? { enabled: false } : {})
  }
}
