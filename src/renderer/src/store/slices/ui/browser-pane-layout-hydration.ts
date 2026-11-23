import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import { normalizeBrowserDevToolsDockLayout } from '../../../../../shared/browser/devtools/browser-devtools-dock'
import { normalizeBrowserExtensionSidePanelWidth } from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'
import type { UISlice } from './ui-slice-contract'

/** Where browser panes dock DevTools and how wide extension side panels are. */
export function hydrateBrowserPaneLayout(
  ui: Pick<PersistedUIState, 'browserDevToolsDock' | 'browserExtensionSidePanelWidth'>
): Pick<UISlice, 'browserDevToolsDock' | 'browserExtensionSidePanelWidth'> {
  return {
    browserDevToolsDock: normalizeBrowserDevToolsDockLayout(ui.browserDevToolsDock),
    browserExtensionSidePanelWidth: normalizeBrowserExtensionSidePanelWidth(
      ui.browserExtensionSidePanelWidth
    )
  }
}
