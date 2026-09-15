export const WORKSPACE_WINDOW_NATIVE_BRIDGE_KEY = 'orcaWorkspaceWindowNative'

export const WORKSPACE_WINDOW_NATIVE_CHANNELS = {
  closeRequested: 'workspaceWindow:closeRequested',
  confirmClose: 'workspaceWindow:confirmClose',
  getWindowId: 'workspaceWindow:getWindowId',
  pickDirectory: 'workspaceWindow:pickDirectory',
  pickFolder: 'workspaceWindow:pickFolder',
  pickFolders: 'workspaceWindow:pickFolders',
  requestClose: 'workspaceWindow:requestClose'
} as const

export type WorkspaceWindowMenuChannel =
  | 'ui:openSettings'
  | 'ui:openSetupGuide'
  | 'ui:openFeatureTour'
  | 'ui:openCrashReport'
  | 'ui:toggleLeftSidebar'
  | 'ui:toggleRightSidebar'
  | 'ui:toggleStatusBar'
  | 'ui:appMenuPaste'
  | 'ui:appMenuSelectionAction'
  | 'terminal:zoom'
