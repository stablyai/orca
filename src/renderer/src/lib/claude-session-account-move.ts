/** Find sessions affected by account selection; resume preserves the session while launch reads the newly selected account folder. */
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess,
  type RuntimeTerminalProcessInspection
} from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'
import {
  getCodexSelectionLaneKey,
  normalizeCodexAccountSelectionTarget,
  type CodexAccountSelectionTarget
} from '../../../shared/codex-selection-lane'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  ClaudeManagedAccount,
  ClaudeRateLimitAccountsState
} from '../../../shared/managed-account-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolvePaneAgentSessionId } from '@/components/terminal-pane/pane-agent-session-id'
import { resolveAgentAccountRestartResumeStartup } from './agent-account-restart-startup'
import {
  isClaudePaneOnAccount,
  resolveClaudePaneFolder,
  type ClaudeHostFolders
} from './claude-pane-account-folder'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane
} from './codex-pane-selection-lane'

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

type LocalClaudePane = ClaudeSessionMoveCandidate & {
  tab: TerminalTab
  laneKey: string
  inLane: boolean
  transcriptPath: string | undefined
}

function* localClaudePanes(
  state: AppState,
  owner: RuntimeClientTarget,
  target: CodexAccountSelectionTarget
): Generator<LocalClaudePane> {
  const isLaneInScope = getCodexAccountSwitchLaneMatcher({ owner, target })
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      const boundPtyIds = state.ptyIdsByTabId[tab.id] ?? []
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      for (const [leafId, ptyId] of Object.entries(leaves)) {
        if (
          !ptyId ||
          !isTerminalLeafId(leafId) ||
          !boundPtyIds.includes(ptyId) ||
          isForeignMachineCodexPtyId(ptyId)
        ) {
          continue
        }
        const entry = state.agentStatusByPaneKey[makePaneKey(tab.id, leafId)]
        if (entry?.agentType !== 'claude' || entry.structuredHostOwned) {
          continue
        }
        const { laneKey } = resolveCodexPaneSelectionLane({ state, tab, ptyId })
        yield {
          ptyId,
          worktreeId,
          tabId: tab.id,
          leafId,
          tab,
          laneKey,
          inLane: isLaneInScope(laneKey),
          transcriptPath: normalizeAgentProviderSession(entry.providerSession)?.transcriptPath
        }
      }
    }
  }
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
  | { group: 'cantMove'; pane: LocalClaudePane; reason: ClaudeSessionCantMoveReason }

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
  const folder = resolveClaudePaneFolder(pane.transcriptPath, args.saved, args.host)
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
  const resumable = resolveAgentAccountRestartResumeStartup('claude', {
    tabId: pane.tabId,
    leafId: pane.leafId,
    worktreeId: pane.worktreeId,
    shellOverride: pane.tab.shellOverride
  })
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
  pane: LocalClaudePane
): Promise<boolean | 'unchecked'> {
  // Why: a Windows host cannot see processes inside WSL, so the guest's hooks and shell marks decide.
  if (isWslLane(pane.laneKey)) {
    return resolvePaneAgentSessionId(state, makePaneKey(pane.tabId, pane.leafId)) !== null
  }
  return inspectRuntimeTerminalProcess(pane.ptyId).then(
    (inspection) => isClaudeInForeground(pane.ptyId, inspection),
    () => false
  )
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
  /** Sessions on the outgoing account left out because their foreground could not be read. */
  onUnchecked?: (sessions: ClaudeSessionMoveCandidate[]) => void
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
  for (const row of inspected) {
    const candidate = toCandidate(row.pane)
    if (row.running === 'unchecked' && row.group === 'onAccount') {
      unchecked.push(candidate)
    }
    if (row.running !== true) {
      continue
    }
    if (row.group === 'onAccount') {
      found.onAccount.push(candidate)
    } else if (row.group === 'elsewhere') {
      found.elsewhere.push({ ...candidate, accountId: row.accountId })
    } else {
      found.cantMove.push({ ...candidate, reason: row.reason })
    }
  }
  if (unchecked.length > 0) {
    args.onUnchecked?.(unchecked)
  }
  return found
}
