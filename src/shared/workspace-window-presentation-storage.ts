export const WORKSPACE_WINDOW_UI_STORAGE_KEY = 'orca.web.ui.v1'
export const WORKSPACE_WINDOW_SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'
export const WORKSPACE_WINDOW_RUNTIME_IDENTITY_KEY = 'orca.web.runtimeIdentity.v1.'

export function isWorkspaceWindowPresentationKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    (key === WORKSPACE_WINDOW_UI_STORAGE_KEY ||
      key === WORKSPACE_WINDOW_SESSION_STORAGE_KEY ||
      key.startsWith(`${WORKSPACE_WINDOW_SESSION_STORAGE_KEY}.runtime:`) ||
      key.startsWith(`${WORKSPACE_WINDOW_SESSION_STORAGE_KEY}.ssh:`) ||
      key.startsWith(WORKSPACE_WINDOW_RUNTIME_IDENTITY_KEY))
  )
}
