import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { CodexAccountSelectionTarget } from '../../../shared/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../shared/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { INLINE_ACTION_CLASS_NAMES } from '@/components/ui/sonner'
import { getClaudeAccountLabel } from './claude-account-label'
import type { ClaudeHostFolders } from './claude-pane-account-folder'
import {
  claudeLaunchAccountId,
  findClaudeSwitchSessions,
  findQueuedClaudeRestartsOnAccount,
  type ClaudeSessionMoveCandidate,
  type ClaudeSwitchSessions
} from './claude-session-account-move'

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
}): Promise<'show-confirmation' | 'handled'> {
  const fromAccountId = claudeLaunchAccountId(args.before.state, args.before.accountId)
  const toAccountId = claudeLaunchAccountId(args.after.state, args.after.accountId)
  // Why: a server's switch, or one between coinciding launch folders, moves nothing here.
  if (args.owner.kind !== 'local' || fromAccountId === toAccountId) {
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
    }
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return null
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
  // Why: other sessions are listed only alongside a move, so parallel-account users get no prompt.
  if (!found || found.onAccount.length === 0) {
    return 'show-confirmation'
  }
  const nextAccountLabel = getClaudeAccountLabel(args.after.state, args.after.accountId)
  const sessions: ClaudeAccountSwitchPromptSessions = {
    ...found,
    elsewhere: found.elsewhere.map((session) => ({
      ...session,
      accountLabel: getClaudeAccountLabel(args.after.state, session.accountId)
    }))
  }
  const labels = {
    previousAccountLabel: getClaudeAccountLabel(args.before.state, args.before.accountId),
    nextAccountLabel
  }
  if (policy === 'restart') {
    queueClaudeRestarts(found.onAccount.map((candidate) => candidate.ptyId))
    const others = found.elsewhere.length + found.cantMove.length
    announceRestart(found.onAccount.length, nextAccountLabel, others, () => {
      if (generation === switchGeneration) {
        setPrompt({
          id: generation,
          review: true,
          sessions: { ...sessions, onAccount: [] },
          ...labels
        })
      }
    })
    return 'handled'
  }
  setPrompt({ id: generation, sessions, ...labels })
  return 'handled'
}

/** Name the sessions left behind and offer the same list, without the ones already restarting. */
function announceRestart(count: number, account: string, others: number, review: () => void): void {
  const title =
    count === 1
      ? translate(
          'accounts.claude.switchSessions.restartingOne',
          'Restarting 1 Claude session on {{account}}',
          { account }
        )
      : translate(
          'accounts.claude.switchSessions.restartingOther',
          'Restarting {{count}} Claude sessions on {{account}}',
          { count, account }
        )
  if (others === 0) {
    toast.success(title)
    return
  }
  toast.success(title, {
    description:
      others === 1
        ? translate('accounts.claude.switchSessions.notMovedOne', "1 other session wasn't moved.")
        : translate(
            'accounts.claude.switchSessions.notMovedOther',
            "{{count}} other sessions weren't moved.",
            { count: others }
          ),
    classNames: INLINE_ACTION_CLASS_NAMES,
    action: {
      label: translate('accounts.claude.switchSessions.review', 'Review'),
      onClick: review
    }
  })
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
