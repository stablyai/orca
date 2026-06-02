import type { AppState } from '@/store/types'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import type { Worktree } from '../../../../shared/types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'

export type CmdJUnavailableReason =
  | 'loading'
  | 'no-active-workspace'
  | 'ssh-disconnected'
  | 'no-active-group'

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
  activeGroupId: string | null
  openNewBrowserTab: (groupId: string) => Promise<void>
  openNewMarkdownFile: (groupId: string) => Promise<void>
  openNewTerminalTab: (groupId: string) => Promise<void>
  openCreateWorkspace: () => void
  deleteActiveWorkspace: () => void
  openAddQuickCommand: () => void
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
  openNewBrowserTab: (groupId: string) => Promise<void>
  openNewMarkdownFile: (groupId: string) => Promise<void>
  openNewTerminalTab: (groupId: string) => Promise<void>
  openCreateWorkspace: () => void
  deleteActiveWorkspace: () => void
  openAddQuickCommand: () => void
}): CmdJQuickActionContext {
  const activeWorktreeId = args.state.activeWorktreeId
  const activeWorktree = activeWorktreeId
    ? (findWorktreeById(args.state.worktreesByRepo, activeWorktreeId) ?? null)
    : null
  const activeGroupId = resolveCmdJActiveGroupId(
    args.state,
    activeWorktreeId,
    args.activeGroupSnapshot
  )
  const isLoading =
    args.state.repos.length > 0 && Object.keys(args.state.worktreesByRepo).length === 0
  const runtimeMode =
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ &&
    args.state.settings?.activeRuntimeEnvironmentId?.trim()
      ? 'paired-web'
      : 'local-desktop'

  return {
    activeView: args.state.activeView,
    activeWorktreeId,
    activeWorktree,
    isLoading,
    sshStatus: getActiveWorktreeSshStatus(args.state, activeWorktree),
    runtimeMode,
    activeGroupId,
    openNewBrowserTab: args.openNewBrowserTab,
    openNewMarkdownFile: args.openNewMarkdownFile,
    openNewTerminalTab: args.openNewTerminalTab,
    openCreateWorkspace: args.openCreateWorkspace,
    deleteActiveWorkspace: args.deleteActiveWorkspace,
    openAddQuickCommand: args.openAddQuickCommand
  }
}

export function getUnavailableQuickActionMessage(
  actionTitle: string,
  reason: CmdJUnavailableReason
): string {
  switch (reason) {
    case 'loading':
      return `Can't ${actionTitle.toLowerCase()} — workspace is still loading.`
    case 'no-active-workspace':
      return `Can't ${actionTitle.toLowerCase()} — no workspace is active.`
    case 'ssh-disconnected':
      return `Can't ${actionTitle.toLowerCase()} — workspace is disconnected.`
    case 'no-active-group':
      return `Can't ${actionTitle.toLowerCase()} — no tab group is available.`
  }
}
