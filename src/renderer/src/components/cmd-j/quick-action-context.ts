import type { AppState } from '@/store/types'
import { translate } from '@/i18n/i18n'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { Worktree } from '../../../../shared/worktree/types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import {
  canRunNativeChatSplitTarget,
  resolveActiveNativeChatSplitTarget,
  runActiveNativeChatSplit
} from '@/components/native-chat/native-chat-layout-actions'
import type { NativeChatSplitDirection } from '@/components/native-chat/native-chat-split-shortcut'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { TabSplitDirection } from '@/store/slices/tabs/tabs-slice-contract'

export type CmdJUnavailableReason =
  | 'loading'
  | 'no-active-workspace'
  | 'ssh-disconnected'
  | 'no-active-group'
  | 'no-active-chat'
  | 'client-action-unsupported'

export type CmdJQuickActionAvailability =
  | { available: true }
  | { available: false; reason: CmdJUnavailableReason }

export type CmdJActiveGroupSnapshot = {
  worktreeId: string
  groupId: string | null
}

export type CmdJQuickActionContext = {
  activeView: AppState['activeView']
  activeWorktreeId: string | null
  activeWorktree: Worktree | null
  isLoading: boolean
  sshStatus: SshConnectionStatus | null
  runtimeMode: 'local-desktop' | 'paired-web'
  managedBrowserCreationEnabled?: boolean
  activeGroupId: string | null
  openNewBrowserTab: (groupId: string, splitDirection?: TabSplitDirection) => Promise<void>
  openBrowserUrl: (groupId: string, url: string) => Promise<void>
  openNewMarkdownFile: (groupId: string) => Promise<void>
  openNewTerminalTab: (groupId: string) => Promise<void>
  openCreateWorkspace: () => void
  deleteActiveWorkspace: () => void
  openAddQuickCommand: () => void
  canSplitActiveChat?: boolean
  splitActiveChat?: (direction: NativeChatSplitDirection) => boolean
}

export function resolveCmdJActiveGroupId(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>,
  worktreeId: string | null,
  snapshot?: CmdJActiveGroupSnapshot | null
): string | null {
  if (!worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  if (groups.length === 0) {
    return null
  }

  if (snapshot?.worktreeId === worktreeId) {
    if (snapshot.groupId && groups.some((group) => group.id === snapshot.groupId)) {
      return snapshot.groupId
    }
    return groups[0]?.id ?? null
  }

  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId]
  if (focusedGroupId && groups.some((group) => group.id === focusedGroupId)) {
    return focusedGroupId
  }
  return groups[0]?.id ?? null
}

export function captureCmdJActiveGroupSnapshot(
  state: Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>,
  worktreeId: string | null
): CmdJActiveGroupSnapshot | null {
  if (!worktreeId) {
    return null
  }
  return {
    worktreeId,
    groupId: resolveCmdJActiveGroupId(state, worktreeId)
  }
}

export function getActiveWorktreeSshStatus(
  state: Pick<AppState, 'repos' | 'sshConnectionStates' | 'worktreesByRepo'>,
  activeWorktree: Worktree | null
): SshConnectionStatus | null {
  if (!activeWorktree) {
    return null
  }
  const repo = state.repos.find((entry) => entry.id === activeWorktree.repoId)
  const connectionId = repo?.connectionId ?? null
  if (!connectionId) {
    return null
  }
  return state.sshConnectionStates.get(connectionId)?.status ?? 'disconnected'
}

export function getWorkspaceScopedActionAvailability(
  ctx: Pick<
    CmdJQuickActionContext,
    'activeGroupId' | 'activeWorktreeId' | 'isLoading' | 'sshStatus'
  >
): CmdJQuickActionAvailability {
  if (!ctx.activeWorktreeId) {
    return { available: false, reason: 'no-active-workspace' }
  }
  if (ctx.isLoading) {
    return { available: false, reason: 'loading' }
  }
  if (ctx.sshStatus != null && ctx.sshStatus !== 'connected') {
    return { available: false, reason: 'ssh-disconnected' }
  }
  if (!ctx.activeGroupId) {
    return { available: false, reason: 'no-active-group' }
  }
  return { available: true }
}

export function getBrowserWorkspaceActionAvailability(
  ctx: CmdJQuickActionContext
): CmdJQuickActionAvailability {
  if (ctx.managedBrowserCreationEnabled === false) {
    return { available: false, reason: 'client-action-unsupported' }
  }
  return getWorkspaceScopedActionAvailability(ctx)
}

export function getCurrentWorkspaceActionAvailability(
  ctx: Pick<CmdJQuickActionContext, 'activeView' | 'activeWorktreeId' | 'isLoading' | 'sshStatus'>
): CmdJQuickActionAvailability {
  if (ctx.activeView !== 'terminal' || !ctx.activeWorktreeId) {
    return { available: false, reason: 'no-active-workspace' }
  }
  if (ctx.isLoading) {
    return { available: false, reason: 'loading' }
  }
  if (ctx.sshStatus != null && ctx.sshStatus !== 'connected') {
    return { available: false, reason: 'ssh-disconnected' }
  }
  return { available: true }
}

export function buildCmdJQuickActionContext(args: {
  state: AppState
  activeGroupSnapshot: CmdJActiveGroupSnapshot | null
  openNewBrowserTab: (groupId: string, splitDirection?: TabSplitDirection) => Promise<void>
  openBrowserUrl: (groupId: string, url: string) => Promise<void>
  openNewMarkdownFile: (groupId: string) => Promise<void>
  openNewTerminalTab: (groupId: string) => Promise<void>
  openCreateWorkspace: () => void
  deleteActiveWorkspace: () => void
  openAddQuickCommand: () => void
}): CmdJQuickActionContext {
  const activeWorktreeId = args.state.activeWorktreeId
  const activeWorktree = activeWorktreeId
    ? (findWorktreeById(selectWorktreesByRepo(args.state), activeWorktreeId) ?? null)
    : null
  const activeGroupId = resolveCmdJActiveGroupId(
    args.state,
    activeWorktreeId,
    args.activeGroupSnapshot
  )
  const isLoading =
    args.state.repos.length > 0 && Object.keys(selectWorktreesByRepo(args.state)).length === 0
  const runtimeMode =
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ &&
    args.state.settings?.activeRuntimeEnvironmentId?.trim()
      ? 'paired-web'
      : 'local-desktop'
  const managedBrowserCreationEnabled =
    getClientCreationActionPolicy(args.state, activeWorktreeId)['managed-browser'].state ===
    'enabled'
  const activeChatTarget =
    args.state.activeView === 'terminal'
      ? resolveActiveNativeChatSplitTarget(args.state, activeWorktreeId, activeGroupId)
      : null

  return {
    activeView: args.state.activeView,
    activeWorktreeId,
    activeWorktree,
    isLoading,
    sshStatus: getActiveWorktreeSshStatus(args.state, activeWorktree),
    runtimeMode,
    managedBrowserCreationEnabled,
    activeGroupId,
    openNewBrowserTab: args.openNewBrowserTab,
    openBrowserUrl: args.openBrowserUrl,
    openNewMarkdownFile: args.openNewMarkdownFile,
    openNewTerminalTab: args.openNewTerminalTab,
    openCreateWorkspace: args.openCreateWorkspace,
    deleteActiveWorkspace: args.deleteActiveWorkspace,
    openAddQuickCommand: args.openAddQuickCommand,
    canSplitActiveChat: canRunNativeChatSplitTarget(args.state, activeChatTarget),
    splitActiveChat: (direction) =>
      runActiveNativeChatSplit(activeWorktreeId, activeGroupId, direction)
  }
}

export function getUnavailableQuickActionMessage(
  actionTitle: string,
  reason: CmdJUnavailableReason
): string {
  // Quote the localized title instead of lowercasing it into the sentence.
  const options = { action: actionTitle }
  switch (reason) {
    case 'loading':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.workspaceLoading',
        'Can’t run “{{action}}” — workspace is still loading.',
        options
      )
    case 'no-active-workspace':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.noActiveWorkspace',
        'Can’t run “{{action}}” — no workspace is active.',
        options
      )
    case 'ssh-disconnected':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.workspaceDisconnected',
        'Can’t run “{{action}}” — workspace is disconnected.',
        options
      )
    case 'no-active-group':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.noTabGroup',
        'Can’t run “{{action}}” — no tab group is available.',
        options
      )
    case 'no-active-chat':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.noMovableChat',
        'Can’t run “{{action}}” — no movable chat is active.',
        options
      )
    case 'client-action-unsupported':
      return translate(
        'auto.components.cmdJ.quickActionUnavailable.clientUnsupported',
        'Can’t run “{{action}}” — this client and runtime do not support it.',
        options
      )
  }
}
