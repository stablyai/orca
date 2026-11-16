/** Find sessions affected by account selection; resume preserves the session while launch reads the newly selected account folder. */

/** Find sessions affected by account selection; resume preserves the session while launch reads the newly selected account folder. */
import { useAppStore } from '@/store/index'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { TerminalProcessInspection as RuntimeTerminalProcessInspection } from '../../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget
} from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { CodexAccountSelectionTarget } from '../../../../../../shared/agent-accounts/codex/codex-selection-lane'
import { resolvePaneAgentSessionId } from '@/lib/agent-session/identity/pane-agent-session-id'
import { resolveAgentAccountRestartResumeStartup } from '../agent-account-restart-startup'
import { isSessionHeldByAnotherPane } from '../../identity/claude-session-pane-holders'
import { isClaudePaneOnAccount, resolveClaudePaneFolder } from './claude-pane-account-folder'
import type { ClaudeHostFolders } from './claude-pane-account-folder'
import { isLocalCodexSelectionLaneKey } from '../codex-pane-selection-lane'
import type { AppState } from '@/store/types'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../../../../shared/agent-accounts/managed-account-types'
import type { ClaudePaneLookups } from './claude-queued-restart-records'
import {
  claudeSwitchCandidatePanes,
  hasSleepingSession,
  type ClaudeSwitchCandidatePane
} from './claude-switch-candidate-panes'

export type ClaudeSessionMoveCandidate = {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
}

// Match npm Claude by its fresh command line: generic node/python may now run user programs.
function isClaudeProcess(processName: string | null): boolean {
  return recognizeAgentProcess(processName)?.agent === 'claude'
}

/** Confirm foreground identity: cached names flap to shells and native macOS binaries report version-folder names. */
async function isClaudeInForeground(
  ptyId: string,
  inspection: RuntimeTerminalProcessInspection
): Promise<boolean | 'unchecked'> {
  if (isClientOnlyUnverifiableInspection(inspection)) {
    return false
  }
  if (isClaudeProcess(inspection.foregroundProcess)) {
    return true
  }
  const fresh = await confirmRuntimeTerminalForegroundProcess(ptyId)
  // Why: a bare node/python may be an npm Claude, but only the failed fresh read could have said so.
  if (fresh === null && isAgentForegroundWrapperProcess(inspection.foregroundProcess ?? '')) {
    return 'unchecked'
  }
  return isClaudeProcess(fresh)
}

/** Whether the pane's Claude is mid-turn; a restart during a permission prompt or question drops it. */
export function isClaudePaneMidTurn(state: AppState, paneKey: string): boolean {
  const entry = state.agentStatusByPaneKey.get(paneKey)
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
  | { group: 'onAccount'; pane: ClaudeSwitchCandidatePane }
  | { group: 'elsewhere'; pane: ClaudeSwitchCandidatePane; accountId: string | null }
  | { group: 'cantMove'; pane: ClaudeSwitchCandidatePane; reason: ClaudeSessionCantMoveReason }

export type InspectedClaudePane = ScannedPane & { running: boolean | 'unchecked' }

function scanPane(
  pane: ClaudeSwitchCandidatePane,
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
  const folder = resolveClaudePaneFolder(pane.session?.transcriptPath, args.saved, args.host)
  if (!folder) {
    return { group: 'cantMove', pane, reason: 'unknown-account' }
  }
  // Why: the shell function keeps a pane's own CLAUDE_CONFIG_DIR, so a restart lands in the same folder.
  if (folder.kind === 'own-folder') {
    return { group: 'cantMove', pane, reason: 'own-folder' }
  }
  if (isClaudePaneOnAccount(folder, args.toAccountId, args.host)) {
    return null
  }
  const resumable = resolveAgentAccountRestartResumeStartup(
    'claude',
    {
      tabId: pane.tabId,
      leafId: pane.leafId,
      worktreeId: pane.worktreeId,
      shellOverride: pane.tab.shellOverride
    },
    pane.session
  )
  if (!resumable) {
    return { group: 'cantMove', pane, reason: 'no-session' }
  }
  return isClaudePaneOnAccount(folder, args.fromAccountId, args.host)
    ? { group: 'onAccount', pane }
    : {
        group: 'elsewhere',
        pane,
        accountId: folder.kind === 'account' ? folder.accountId : null
      }
}

function isWslLane(laneKey: string): boolean {
  return isLocalCodexSelectionLaneKey(laneKey) && laneKey !== getCodexSelectionLaneKey(null)
}

async function isClaudeRunning(
  state: AppState,
  pane: ClaudeSwitchCandidatePane
): Promise<boolean | 'unchecked'> {
  // Why: a Windows host cannot see processes inside WSL, so the guest's hooks and shell marks decide.
  if (isWslLane(pane.laneKey)) {
    return resolvePaneAgentSessionId(state, makePaneKey(pane.tabId, pane.leafId)) !== null
  }
  return inspectRuntimeTerminalProcess(pane.ptyId).then(
    (inspection) => isClaudeInForeground(pane.ptyId, inspection),
    () => 'unchecked' as const
  )
}

function sleepingPaneRow(state: AppState, pane: ClaudeSwitchCandidatePane): ScannedPane | null {
  return pane.inLane && hasSleepingSession(state, pane)
    ? { group: 'cantMove', pane, reason: 'no-session' }
    : null
}

function toCandidate(pane: ClaudeSwitchCandidatePane): ClaudeSessionMoveCandidate {
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
  restartAll: boolean
  discovered?: ClaudePaneLookups
  /** Sessions on the outgoing account left out because their foreground could not be read. */
  onUnchecked?: (sessions: ClaudeSessionMoveCandidate[]) => void
  /** Sessions on any other account left out because their foreground could not be read. */
  onUncheckedOthers?: (sessions: ClaudeSessionMoveCandidate[]) => void
  /** Sessions on the outgoing account kept running because another pane holds their conversation. */
  onShared?: (sessions: ClaudeSessionMoveCandidate[]) => void
  onInspected?: (panes: ClaudeSwitchCandidatePane[], inspected: InspectedClaudePane[]) => void
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
  const panes = [
    ...claudeSwitchCandidatePanes(state, args.owner, args.target, args.restartAll, args.discovered)
  ]
  const scanned = panes.flatMap((pane) => {
    const row = pane.entry || pane.session ? scanPane(pane, scanArgs) : sleepingPaneRow(state, pane)
    return row ? [row] : []
  })
  const inspected: InspectedClaudePane[] = await Promise.all(
    scanned.map(async (row) => ({ ...row, running: await isClaudeRunning(state, row.pane) }))
  )
  args.onInspected?.(panes, inspected)
  const unchecked: ClaudeSessionMoveCandidate[] = []
  const uncheckedOthers: ClaudeSessionMoveCandidate[] = []
  const shared: ClaudeSessionMoveCandidate[] = []
  for (const row of inspected) {
    const candidate = toCandidate(row.pane)
    if (row.running === 'unchecked' && row.group === 'onAccount') {
      unchecked.push(candidate)
    } else if (row.running === 'unchecked') {
      uncheckedOthers.push(candidate)
    }
    if (row.running !== true) {
      continue
    }
    const paneKey = makePaneKey(row.pane.tabId, row.pane.leafId)
    if (
      row.group !== 'cantMove' &&
      row.pane.session &&
      isSessionHeldByAnotherPane(state, paneKey, row.pane.session.id, args.discovered)
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
  if (uncheckedOthers.length > 0) {
    args.onUncheckedOthers?.(uncheckedOthers)
  }
  return found
}
