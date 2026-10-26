import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ClaudeRateLimitAccountsState } from '../../../shared/managed-account-types'
import { getClaudeAccountLabel } from './claude-account-label'
import {
  claudeLaunchAccountId,
  findMovableClaudeSessions,
  findQueuedClaudeRestartsOnAccount,
  type ClaudeSessionMoveCandidate
} from './claude-session-account-move'

export type ClaudeAccountSwitchPrompt = {
  id: number
  sessions: ClaudeSessionMoveCandidate[]
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
    const picked = chosen
      ? request.sessions.filter((session) => chosen.includes(session.ptyId))
      : request.sessions
    queueClaudeRestarts(currentPtyIds(picked))
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ claudeAccountSwitchRunningSessions: 'restart' })
  }
}

export type ClaudeAccountSnapshot = {
  state: Pick<ClaudeRateLimitAccountsState, 'accounts'>
  accountId: string | null
}

/** After account selection applies, ask/restart/retain sessions on the outgoing account; show-confirmation leaves the caller’s toast. */
export async function handleRunningClaudeSessionsAfterSwitch(args: {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  before: ClaudeAccountSnapshot
  after: ClaudeAccountSnapshot
}): Promise<'show-confirmation' | 'handled'> {
  const fromAccountId = claudeLaunchAccountId(args.before.state, args.before.accountId)
  const toAccountId = claudeLaunchAccountId(args.after.state, args.after.accountId)
  // Why: a server's switch, or one between coinciding launch folders, moves nothing here.
  if (args.owner.kind !== 'local' || fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const generation = ++switchGeneration
  setPrompt(null)
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives switches.
  const store = useAppStore.getState()
  for (const ptyId of findQueuedClaudeRestartsOnAccount({
    owner: args.owner,
    target: args.target,
    accountId: toAccountId
  })) {
    store.consumePendingPaneAccountRestart(ptyId)
  }
  if (readPolicy() === 'keep') {
    return 'show-confirmation'
  }
  let uncheckedCount = 0
  const found = await findMovableClaudeSessions({
    owner: args.owner,
    target: args.target,
    fromAccountId,
    onUnchecked: (sessions) => {
      uncheckedCount = sessions.length
      console.warn(
        '[claude-account-switch] could not read the foreground of',
        sessions.map((session) => session.ptyId)
      )
    }
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return []
  })
  if (generation !== switchGeneration) {
    return 'handled'
  }
  // Why re-read: the setting may change while the scan runs.
  const policy = readPolicy()
  if (policy === 'keep') {
    return 'show-confirmation'
  }
  if (uncheckedCount > 0) {
    warnUncheckedSessions(
      uncheckedCount,
      getClaudeAccountLabel(args.before.state, args.before.accountId)
    )
  }
  if (found.length === 0) {
    return 'show-confirmation'
  }
  const nextAccountLabel = getClaudeAccountLabel(args.after.state, args.after.accountId)
  if (policy === 'restart') {
    queueClaudeRestarts(found.map((candidate) => candidate.ptyId))
    toast.success(
      found.length === 1
        ? translate(
            'accounts.claude.switchSessions.restartingOne',
            'Restarting 1 Claude session on {{account}}',
            { account: nextAccountLabel }
          )
        : translate(
            'accounts.claude.switchSessions.restartingOther',
            'Restarting {{count}} Claude sessions on {{account}}',
            { count: found.length, account: nextAccountLabel }
          )
    )
    return 'handled'
  }
  setPrompt({
    id: generation,
    sessions: found,
    previousAccountLabel: getClaudeAccountLabel(args.before.state, args.before.accountId),
    nextAccountLabel
  })
  return 'handled'
}

/** Why a toast: these sessions keep the previous account, and only a manual restart moves them. */
function warnUncheckedSessions(count: number, previous: string): void {
  toast.warning(
    count === 1
      ? translate(
          'accounts.claude.switchSessions.uncheckedOne',
          "Couldn't check 1 terminal for Claude. If Claude is running there, it stays on {{previous}} until restarted.",
          { previous }
        )
      : translate(
          'accounts.claude.switchSessions.uncheckedOther',
          "Couldn't check {{count}} terminals for Claude. Any Claude running there stays on {{previous}} until restarted.",
          { count, previous }
        )
  )
}

function readPolicy(): ClaudeAccountSwitchRunningSessions {
  return useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
}

export function resetClaudeAccountSwitchSessionsForTests(): void {
  switchGeneration = 0
  setPrompt(null)
}
