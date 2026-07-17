import { isWebAiBrowserWorkspaceId } from '../../../shared/constants'
import type { BrowserWorkspace, WebAiAccount, WorkspaceVisibleTabType } from '../../../shared/types'
import { normalizeWebAiAccounts, webAiAccountMatchesBinding } from '../../../shared/web-ai-accounts'

export type WorkspaceNewTabShortcutContext = {
  activeBrowserTabId: string | null
  activeTabType: WorkspaceVisibleTabType
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
  webAiAccounts: unknown
}

export type WorkspaceNewTabShortcutTarget =
  | { kind: 'browser' }
  | { kind: 'terminal' }
  | { kind: 'web-ai-account'; account: WebAiAccount }

export function resolveWorkspaceNewTabShortcutTarget(
  workspaceId: string | null,
  context?: WorkspaceNewTabShortcutContext
): WorkspaceNewTabShortcutTarget {
  if (isWebAiBrowserWorkspaceId(workspaceId)) {
    return { kind: 'browser' }
  }
  if (!workspaceId || context?.activeTabType !== 'browser' || !context.activeBrowserTabId) {
    return { kind: 'terminal' }
  }
  const activeWorkspace = (context.browserTabsByWorktree[workspaceId] ?? []).find(
    (workspace) => workspace.id === context.activeBrowserTabId
  )
  if (!activeWorkspace?.webAiAccountId) {
    return { kind: 'terminal' }
  }
  const account = normalizeWebAiAccounts(context.webAiAccounts).find((candidate) =>
    webAiAccountMatchesBinding(candidate, activeWorkspace)
  )
  return account ? { kind: 'web-ai-account', account } : { kind: 'terminal' }
}

export function dispatchWorkspaceNewTabShortcut(
  workspaceId: string | null,
  actions: {
    openBrowserTab: () => void
    openTerminalTab: () => void
    openWebAiAccountTab?: (account: WebAiAccount) => void
  },
  context?: WorkspaceNewTabShortcutContext
): 'browser' | 'terminal' {
  const target = resolveWorkspaceNewTabShortcutTarget(workspaceId, context)
  if (target.kind === 'browser') {
    actions.openBrowserTab()
    return 'browser'
  }
  if (target.kind === 'web-ai-account') {
    if (actions.openWebAiAccountTab) {
      actions.openWebAiAccountTab(target.account)
    } else {
      actions.openBrowserTab()
    }
    return 'browser'
  }

  actions.openTerminalTab()
  return 'terminal'
}
