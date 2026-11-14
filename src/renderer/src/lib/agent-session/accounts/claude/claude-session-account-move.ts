/** Find sessions affected by account selection; resume preserves the session while launch reads the newly selected account folder. */
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { normalizeCodexAccountSelectionTarget } from '../../../../../../shared/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/codex-selection-lane'
import { resolveAgentAccountRestartResumeStartup } from '../agent-account-restart-startup'
import { isSessionHeldByAnotherPane } from '../../identity/claude-session-pane-holders'
import { isClaudePaneOnAccount, resolveClaudePaneFolder } from './claude-pane-account-folder'
import type { ClaudeHostFolders } from './claude-pane-account-folder'
import {
  isClaudeRunning,
  isWslLane,
  localClaudePanes,
  type ClaudeSessionMoveCandidate,
  type LocalClaudePane
} from './claude-pane-inventory'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../../../../shared/managed-account-types'

export type { ClaudeSessionMoveCandidate } from './claude-pane-inventory'

export function isClaudePaneMidTurn(state: AppState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey[paneKey]
  return entry?.agentType === 'claude' && entry.state !== 'done'
}

/** Resolve the account actually used at launch; an account without its own login may use System default (null). */
export function claudeLaunchAccountId(
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>,
  accountId: string | null
): string | null {
  const account = state.accounts.find((candidate) => candidate.id === accountId)
  return account?.runsOnSystemDefault ? null : accountId
}

export function findQueuedClaudeRestartsOnAccount(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  accountId: string | null
  host?: ClaudeHostFolders
}): string[] {
  const state = useAppStore.getState()
  const saved = state.settings?.claudeManagedAccounts ?? []
  const host = isHostTarget(args.target) ? args.host : undefined
  const ptyIds: string[] = []
  for (const pane of localClaudePanes(state, args.owner, args.target)) {
    if (
      pane.inLane &&
      state.pendingPaneAccountRestarts[pane.ptyId] === 'claude' &&
      isClaudePaneOnAccount(
        resolveClaudePaneFolder(pane.transcriptPath, saved, host),
        args.accountId,
        host
      )
    ) {
      ptyIds.push(pane.ptyId)
    }
  }
  return ptyIds
}

function isHostTarget(target: CodexAccountSelectionTarget): boolean {
  return normalizeCodexAccountSelectionTarget(target).runtime === 'host'
}

export type ClaudeSessionCantMoveReason =
  | 'wsl-terminal'
  | 'own-folder'
  | 'unknown-account'
  | 'no-session'
  | 'shared-session'

/** Running Claude sessions a switch can see, by what a restart would do for them. */
export type ClaudeSwitchSessions = {
  /** On the account being left. */
  onAccount: ClaudeSessionMoveCandidate[]
  /** On another account, or System default (null), that a restart could also move. */
  elsewhere: (ClaudeSessionMoveCandidate & { accountId: string | null })[]
  cantMove: (ClaudeSessionMoveCandidate & { reason: ClaudeSessionCantMoveReason })[]
}

type ScannedPane =
  | { group: 'onAccount'; pane: LocalClaudePane }
  | { group: 'elsewhere'; pane: LocalClaudePane; accountId: string | null }
  | {
      group: 'cantMove'
      pane: LocalClaudePane
      reason: ClaudeSessionCantMoveReason
      /** Possibly still on the account being left, so the user must restart it to switch. */
      stranded?: true
    }

function scanPane(
  pane: LocalClaudePane,
  args: {
    saved: readonly ClaudeManagedAccount[]
    host: ClaudeHostFolders | undefined
    hostSwitch: boolean
    fromAccountId: string | null
    toAccountId: string | null
  }
): ScannedPane | null {
  if (!pane.inLane) {
    // Why: a host switch leaves WSL alone; SSH and server panes keep independent logins and are not listed.
    return args.hostSwitch && isWslLane(pane.laneKey)
      ? { group: 'cantMove', pane, reason: 'wsl-terminal' }
      : null
  }
  if (!pane.resumable) {
    return { group: 'cantMove', pane, reason: 'no-session', stranded: true }
  }
  const folder = resolveClaudePaneFolder(pane.transcriptPath, args.saved, args.host)
  if (!folder) {
    return { group: 'cantMove', pane, reason: 'unknown-account', stranded: true }
  }
  // Why: the shell function keeps a pane's own CLAUDE_CONFIG_DIR, so a restart lands in the same folder.
  if (folder.kind === 'own-folder') {
    return { group: 'cantMove', pane, reason: 'own-folder' }
  }
  if (isClaudePaneOnAccount(folder, args.toAccountId, args.host)) {
    return null
  }
  const resumable = resolveAgentAccountRestartResumeStartup('claude', {
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: pane.worktreeId,
    shellOverride: pane.tab.shellOverride
  })
  if (!resumable) {
    return isClaudePaneOnAccount(folder, args.fromAccountId, args.host)
      ? { group: 'cantMove', pane, reason: 'no-session', stranded: true }
      : { group: 'cantMove', pane, reason: 'no-session' }
  }
  return isClaudePaneOnAccount(folder, args.fromAccountId, args.host)
    ? { group: 'onAccount', pane }
    : {
        group: 'elsewhere',
        pane,
        accountId: folder.kind === 'account' ? folder.accountId : null
      }
}

function toCandidate(pane: LocalClaudePane): ClaudeSessionMoveCandidate {
  return { ptyId: pane.ptyId, worktreeId: pane.worktreeId, tabId: pane.tabId, leafId: pane.leafId }
}

/** Find local Claude sessions a switch affects; SSH/relay machines keep independent logins. */
export async function findClaudeSwitchSessions(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  /** Null is System default. */
  fromAccountId: string | null
  toAccountId: string | null
  host?: ClaudeHostFolders
  /** Sessions that may be on the outgoing account, left out because their foreground could not be read. */
  onUnchecked?: (sessions: ClaudeSessionMoveCandidate[]) => void
  /** Sessions on the outgoing account kept running because another pane holds their conversation. */
  onShared?: (sessions: ClaudeSessionMoveCandidate[]) => void
  /** Running Claude sessions no restart can move that may still be on the outgoing account. */
  onStranded?: (sessions: ClaudeSessionMoveCandidate[]) => void
}): Promise<ClaudeSwitchSessions> {
  const found: ClaudeSwitchSessions = { onAccount: [], elsewhere: [], cantMove: [] }
  if (args.owner.kind !== 'local') {
    return found
  }
  const state = useAppStore.getState()
  const hostSwitch = isHostTarget(args.target)
  const scanArgs = {
    saved: state.settings?.claudeManagedAccounts ?? [],
    host: hostSwitch ? args.host : undefined,
    hostSwitch,
    fromAccountId: args.fromAccountId,
    toAccountId: args.toAccountId
  }
  const scanned = [...localClaudePanes(state, args.owner, args.target)].flatMap((pane) => {
    const row = scanPane(pane, scanArgs)
    return row ? [row] : []
  })
  const inspected = await Promise.all(
    scanned.map(async (row) => ({ ...row, running: await isClaudeRunning(state, row.pane) }))
  )
  const unchecked: ClaudeSessionMoveCandidate[] = []
  const shared: ClaudeSessionMoveCandidate[] = []
  const stranded: ClaudeSessionMoveCandidate[] = []
  for (const row of inspected) {
    const candidate = toCandidate(row.pane)
    const mayStayBehind = row.group === 'onAccount' || (row.group === 'cantMove' && row.stranded)
    if (row.running === 'unchecked' && mayStayBehind) {
      unchecked.push(candidate)
    }
    if (row.running === true && row.group === 'cantMove' && row.stranded) {
      stranded.push(candidate)
    }
    if (row.running !== true) {
      continue
    }
    const paneKey = makePaneKey(row.pane.tabId, row.pane.leafId)
    if (
      row.group !== 'cantMove' &&
      row.pane.sessionId &&
      isSessionHeldByAnotherPane(state, paneKey, row.pane.sessionId)
    ) {
      found.cantMove.push({ ...candidate, reason: 'shared-session' })
      if (row.group === 'onAccount') {
        shared.push(candidate)
      }
    } else if (row.group === 'onAccount') {
      found.onAccount.push(candidate)
    } else if (row.group === 'elsewhere') {
      found.elsewhere.push({ ...candidate, accountId: row.accountId })
    } else {
      found.cantMove.push({ ...candidate, reason: row.reason })
    }
  }
  if (shared.length > 0) {
    args.onShared?.(shared)
  }
  if (unchecked.length > 0) {
    args.onUnchecked?.(unchecked)
  }
  if (stranded.length > 0) {
    args.onStranded?.(stranded)
  }
  return found
}
