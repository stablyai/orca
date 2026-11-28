import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { normalizeBrowserDevToolsDockLayout } from '../../../../../shared/browser/devtools/browser-devtools-dock'
import { normalizeBrowserExtensionSidePanelWidth } from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'
import { normalizeCrossWorkspacePane } from '../../../../../shared/workspace-view/cross-workspace-pane'
import type { UISlice } from './ui-slice-contract'

type PaneLayoutField =
  | 'browserDevToolsDock'
  | 'browserExtensionSidePanelWidth'
  | 'crossWorkspacePane'

/** Where browser panes dock DevTools, how wide extension side panels are, and the side pane's tab. */
export function hydratePaneLayout(
  ui: Pick<PersistedUIState, PaneLayoutField>
): Pick<UISlice, PaneLayoutField> {
  return {
    browserDevToolsDock: normalizeBrowserDevToolsDockLayout(ui.browserDevToolsDock),
    browserExtensionSidePanelWidth: normalizeBrowserExtensionSidePanelWidth(
      ui.browserExtensionSidePanelWidth
    ),
    crossWorkspacePane: normalizeCrossWorkspacePane(ui.crossWorkspacePane)
  }
}
