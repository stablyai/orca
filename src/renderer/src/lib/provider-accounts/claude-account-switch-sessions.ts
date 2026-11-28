import { useAppStore } from '@/store/index'
import type { CodexAccountSelectionTarget } from '../../../../shared/agent-accounts/codex/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  ClaudeAccountSelectResult,
  ClaudeHostRunningSessionsMove
} from '../../../../shared/agent-accounts/managed-account-types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  announceHostMove,
  announceRestart,
  dismissHostAskToast,
  warnSharedSessions,
  warnStrandedSessions,
  warnUncheckedSessions
} from './claude-account-switch-toasts'
import { getClaudeAccountLabel } from './claude-account-label'
import {
  createAccountSwitchPromptStore,
  currentPtyIds,
  pickedSwitchSessions,
  type AccountSwitchPrompt,
  type AccountSwitchPromptAnswer
} from './account-switch-prompt'
import { moveUnheldClaudeSessions } from './claude-account-switch-unheld-sessions'
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

export type ClaudeAccountSwitchPrompt = Omit<AccountSwitchPrompt, 'sessions'> & {
  sessions: ClaudeAccountSwitchPromptSessions
}

let switchGeneration = 0
const hostAskGenerationByOwner = new Map<string, number>()
const promptStore = createAccountSwitchPromptStore<ClaudeAccountSwitchPrompt>()
const setPrompt = promptStore.set
export const getClaudeAccountSwitchPrompt = promptStore.get
export const subscribeClaudeAccountSwitchPrompt = promptStore.subscribe

function hostOwnerKey(owner: RuntimeClientTarget): string {
  return owner.kind === 'local' ? 'local' : `environment:${owner.environmentId}`
}

function hostAskToastId(ownerKey: string): string {
  return `claude-account-switch-host-ask:${ownerKey}`
}

function nextHostAskGeneration(ownerKey: string): number {
  const next = (hostAskGenerationByOwner.get(ownerKey) ?? 0) + 1
  hostAskGenerationByOwner.set(ownerKey, next)
  dismissHostAskToast(hostAskToastId(ownerKey))
  return next
}

function queueClaudeRestarts(ptyIds: string[]): void {
  useAppStore.getState().queuePaneAccountRestarts(ptyIds, 'claude')
}

/** Answers the open dialog. "Don't ask again" only turns restarts on, as native chat's resume prompt does. */
export const answerClaudeAccountSwitchPrompt: AccountSwitchPromptAnswer = (
  answer,
  options = {}
) => {
  const request = promptStore.get()
  if (!request) {
    return
  }
  setPrompt(null)
  if (answer === 'restart') {
    queueClaudeRestarts(currentPtyIds(pickedSwitchSessions(request.sessions, options.ptyIds)))
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
  const ownerKey = hostOwnerKey(args.owner)
  const toastId = hostAskToastId(ownerKey)
  // Why: a server moves its own sessions and reports them; nothing here runs on it.
  if (args.owner.kind !== 'local') {
    const ownerGeneration = nextHostAskGeneration(ownerKey)
    const { owner, after, hostMove } = args
    return announceHostMove(
      hostMove,
      args.before,
      after,
      async () => {
        if (hostAskGenerationByOwner.get(ownerKey) !== ownerGeneration) {
          return undefined
        }
        // Answers the Ask the server left open; it does nothing once a later switch has replaced it.
        const reply = await callRuntimeRpc<ClaudeAccountSelectResult>(
          owner,
          'accounts.selectClaude',
          {
            accountId: after.accountId,
            runningSessions: 'restart',
            answersAsk: true,
            ...(hostMove?.askId ? { answersAskId: hostMove.askId } : {})
          },
          { timeoutMs: 30_000 }
        )
        return reply.runningSessions
      },
      toastId
    )
  }
  const fromAccountId = claudeLaunchAccountId(args.before.state, args.before.accountId)
  const toAccountId = claudeLaunchAccountId(args.after.state, args.after.accountId)
  if (fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const generation = ++switchGeneration
  const ownerGeneration = nextHostAskGeneration(ownerKey)
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
  if (readClaudeRunningSessionsPolicy() === 'keep') {
    return 'show-confirmation'
  }
  const { target, before, after } = args
  // Why: terminals no pane here is bound to have no other owner; the host moves them by this window's rule.
  const unheld = moveUnheldClaudeSessions({
    target,
    before,
    after,
    runningSessions: readClaudeRunningSessionsPolicy(args.madeElsewhere)
  })
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
  const hostMove = await unheld
  if (generation !== switchGeneration) {
    return 'handled'
  }
  const restartUnheld = () => {
    if (hostAskGenerationByOwner.get(ownerKey) !== ownerGeneration) {
      return Promise.resolve(undefined)
    }
    return moveUnheldClaudeSessions({
      target,
      before,
      after,
      runningSessions: 'restart',
      answersAskFor: after.accountId,
      ...(hostMove?.askId ? { answersAskId: hostMove.askId } : {})
    })
  }
  // Why re-read: the setting may change while the scan runs.
  const policy = readClaudeRunningSessionsPolicy(args.madeElsewhere)
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
    return announceHostMove(hostMove, before, after, restartUnheld, toastId)
  }
  if (policy === 'restart') {
    queueClaudeRestarts(sessions.onAccount.map((candidate) => candidate.ptyId))
    const listed = sessions.elsewhere.length + sessions.cantMove.length
    const restarting = sessions.onAccount.length + (hostMove?.restarting ?? 0)
    // The host's terminals have no rows here, so Review lists only this window's.
    const review = listed > 0 ? () => openReview() : undefined
    announceRestart(restarting, nextAccountLabel, listed + (hostMove?.notMoved ?? 0), review)
    return 'handled'
  }
  setPrompt({ id: generation, sessions, ...labels })
  announceHostMove(hostMove, before, after, restartUnheld, toastId)
  return 'handled'
}

export function readClaudeRunningSessionsPolicy(
  madeElsewhere?: true
): ClaudeAccountSwitchRunningSessions {
  const policy = useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
  // Why: no one at the phone sees a dialog here.
  return policy === 'ask' && madeElsewhere ? 'restart' : policy
}
