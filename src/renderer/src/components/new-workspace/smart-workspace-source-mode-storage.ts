import type { SmartNameMode } from '../../../../shared/new-workspace/smart-workspace-source-results'

// Device-local, like the Jira view mode, rather than synced through ui.set.
const STORAGE_KEY = 'orca.new-workspace.source-mode.v1'
const DEFAULT_MODE: SmartNameMode = 'smart'

// Why: GitLab, Linear and Jira tabs appear only after async connection checks, so restoring them would be reset on first render.
const REMEMBERED_MODES: readonly SmartNameMode[] = ['github', 'branches', 'text']

export function loadSmartWorkspaceSourceMode(): SmartNameMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return REMEMBERED_MODES.find((mode) => mode === stored) ?? DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

export function saveSmartWorkspaceSourceMode(mode: SmartNameMode): void {
  if (mode !== DEFAULT_MODE && !REMEMBERED_MODES.includes(mode)) {
    return
  }
  try {
    // Storing only non-defaults keeps a future default change from being pinned by old devices.
    if (mode === DEFAULT_MODE) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, mode)
    }
  } catch {
    // The live tab stays usable when browser storage is unavailable or full.
  }
}
