import { useAppStore } from '@/store/index'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import {
  announceHostMove,
  announceRestart,
  warnSharedSessions,
  warnStrandedSessions,
  warnUncheckedSessions
} from './claude-account-switch-toasts'
import { getClaudeAccountLabel } from './claude-account-label'
import {
  claudeLaunchAccountId,
  type ClaudeHostFolders
} from '../../../../shared/agent-accounts/claude/claude-pane-account-folder'
import {
  findClaudeSwitchSessions,
  findQueuedClaudeRestartsOnAccount,
  type ClaudeSessionMoveCandidate,
  type ClaudeSwitchSessions
} from '../agent-session/accounts/claude/claude-session-account-move'

export type ClaudeAccountSwitchPromptSessions = {
  onAccount: ClaudeSessionMoveCandidate[]
  elsewhere: (ClaudeSessionMoveCandidate & { accountLabel: string })[]
  cantMove: ClaudeSwitchSessions['cantMove']
}

export type ClaudeAccountSwitchPrompt = {
  id: number
  sessions: ClaudeAccountSwitchPromptSessions
  /** Opened from the restart toast: the outgoing account's sessions are already restarting. */
  review?: true
  previousAccountLabel: string
  nextAccountLabel: string
}

let switchGeneration = 0
let prompt: ClaudeAccountSwitchPrompt | null = null
const promptListeners = new Set<() => void>()

function setPrompt(next: ClaudeAccountSwitchPrompt | null): void {
  prompt = next
  for (const listener of promptListeners) {
    listener()
  }
}

export function getClaudeAccountSwitchPrompt(): ClaudeAccountSwitchPrompt | null {
  return prompt
}

export function subscribeClaudeAccountSwitchPrompt(listener: () => void): () => void {
  promptListeners.add(listener)
  return () => promptListeners.delete(listener)
}

function queueClaudeRestarts(ptyIds: string[]): void {
  useAppStore.getState().queuePaneAccountRestarts(ptyIds, 'claude')
}

/** Why now: a reattach can rebind a pane while the dialog is open, and a closed pane has none. */
function currentPtyIds(sessions: readonly ClaudeSessionMoveCandidate[]): string[] {
  const layouts = useAppStore.getState().terminalLayoutsByTabId
  return sessions.flatMap((session) => {
    const ptyId = layouts[session.tabId]?.ptyIdsByLeafId?.[session.leafId]
    return ptyId ? [ptyId] : []
  })
}

/** Answers the open dialog. "Don't ask again" only turns restarts on, as native chat's resume prompt does. */
export function answerClaudeAccountSwitchPrompt(
  answer: 'restart' | 'keep',
  options: {
    /** The sessions the user ticked; every listed session when absent. */
    ptyIds?: readonly string[]
    dontAskAgain?: boolean
  } = {}
): void {
  const request = prompt
  if (!request) {
    return
  }
  setPrompt(null)
  if (answer === 'restart') {
    const chosen = options.ptyIds
    // Why filtered: only sessions this question listed may restart.
    const listed = [...request.sessions.onAccount, ...request.sessions.elsewhere]
    const picked = chosen ? listed.filter((session) => chosen.includes(session.ptyId)) : listed
    queueClaudeRestarts(currentPtyIds(picked))
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ claudeAccountSwitchRunningSessions: 'restart' })
  }
}

export type ClaudeAccountSnapshot = {
  state: ClaudeHostFolders
  accountId: string | null
}

/** After account selection applies, ask/restart/retain sessions on the outgoing account; show-confirmation leaves the caller’s toast. */
export async function handleRunningClaudeSessionsAfterSwitch(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  before: ClaudeAccountSnapshot
  after: ClaudeAccountSnapshot
  /** Switched from a phone or the CLI, where no one can answer a dialog on this computer. */
  madeElsewhere?: true
  /** What a server did with its own running sessions; absent from older servers. */
  hostMove?: ClaudeHostRunningSessionsMove
}): Promise<'show-confirmation' | 'handled'> {
  // Why: a server moves its own sessions and reports them; nothing here runs on it.
  if (args.owner.kind !== 'local') {
    return announceHostMove(args.hostMove, args.before, args.after)
  }
  const fromAccountId = claudeLaunchAccountId(args.before.state, args.before.accountId)
  const toAccountId = claudeLaunchAccountId(args.after.state, args.after.accountId)
  if (fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const generation = ++switchGeneration
  setPrompt(null)
  // Why the new list: main read its folders and logins as it applied the switch.
  const host = args.after.state
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives switches.
  const store = useAppStore.getState()
  for (const ptyId of findQueuedClaudeRestartsOnAccount({
    owner: args.owner,
    target: args.target,
    accountId: toAccountId,
    host
  })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
  if (readPolicy() === 'keep') {
    return 'show-confirmation'
  }
  let uncheckedCount = 0
  let sharedCount = 0
  let strandedPtyIds: ReadonlySet<string> = new Set()
  const found = await findClaudeSwitchSessions({
    owner: args.owner,
    target: args.target,
    fromAccountId,
    toAccountId,
    host,
    onUnchecked: (sessions) => {
      uncheckedCount = sessions.length
      console.warn(
        '[claude-account-switch] could not read the foreground of',
        sessions.map((session) => session.ptyId)
      )
    },
    onShared: (sessions) => {
      sharedCount = sessions.length
    },
    onStranded: (sessions) => {
      strandedPtyIds = new Set(sessions.map((session) => session.ptyId))
    }
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return null
  })
  if (generation !== switchGeneration) {
    return 'handled'
  }
  // Why re-read: the setting may change while the scan runs.
  const policy = readPolicy(args.madeElsewhere)
  if (policy === 'keep') {
    return 'show-confirmation'
  }
  if (uncheckedCount > 0) {
    warnUncheckedSessions(
      uncheckedCount,
      getClaudeAccountLabel(args.before.state, args.before.accountId)
    )
  }
  const nextAccountLabel = getClaudeAccountLabel(args.after.state, args.after.accountId)
  const sessions: ClaudeAccountSwitchPromptSessions = {
    onAccount: found?.onAccount ?? [],
    elsewhere: (found?.elsewhere ?? []).map((session) => ({
      ...session,
      accountLabel: getClaudeAccountLabel(args.after.state, session.accountId)
    })),
    cantMove: found?.cantMove ?? []
  }
  const labels = {
    previousAccountLabel: getClaudeAccountLabel(args.before.state, args.before.accountId),
    nextAccountLabel
  }
  const openReview = (reviewSessions = sessions): void => {
    if (generation === switchGeneration) {
      setPrompt({
        id: generation,
        review: true,
        sessions: { ...reviewSessions, onAccount: [] },
        ...labels
      })
    }
  }
  // Why: other sessions are listed only alongside a move, so parallel-account users get no prompt.
  if (sessions.onAccount.length === 0) {
    if (sharedCount > 0) {
      warnSharedSessions(sharedCount, labels.previousAccountLabel)
    }
    if (strandedPtyIds.size > 0) {
      warnStrandedSessions(strandedPtyIds.size, labels.previousAccountLabel, () =>
        openReview({
          onAccount: [],
          elsewhere: [],
          cantMove: sessions.cantMove.filter((session) => strandedPtyIds.has(session.ptyId))
        })
      )
    }
    return 'show-confirmation'
  }
  if (policy === 'restart') {
    queueClaudeRestarts(sessions.onAccount.map((candidate) => candidate.ptyId))
    const others = sessions.elsewhere.length + sessions.cantMove.length
    announceRestart(sessions.onAccount.length, nextAccountLabel, others, () => openReview())
    return 'handled'
  }
  setPrompt({ id: generation, sessions, ...labels })
  return 'handled'
}

function readPolicy(madeElsewhere?: true): ClaudeAccountSwitchRunningSessions {
  const policy = useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
  // Why: no one at the phone sees a dialog here.
  return policy === 'ask' && madeElsewhere ? 'restart' : policy
}

export function resetClaudeAccountSwitchSessionsForTests(): void {
  switchGeneration = 0
  setPrompt(null)
}
