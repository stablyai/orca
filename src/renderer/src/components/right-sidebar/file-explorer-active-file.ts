import type { GlobalSettings } from '../../../../shared/global-settings-types'

type ExplorerActiveFileState = {
  settings: Pick<GlobalSettings, 'fileExplorerFollowsActiveFile'> | null
  activeFileId: string | null
}

/** With following off, the active editor must not move selection, scroll or the row highlight (#35887). */
export function explorerActiveFileId(state: ExplorerActiveFileState): string | null {
  return state.settings?.fileExplorerFollowsActiveFile === false ? null : state.activeFileId
}
