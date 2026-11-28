// agy keeps one login per host, so a switch leaves agy already running in this window's terminals on
// the previous account: the setting asks, restarts them, or keeps them as they are.

import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { isTerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { resolveAgentAccountRestartResumeStartup } from '../agent-session/accounts/agent-account-restart-startup'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type {
  AntigravityAccountSelectResult,
  AntigravityAccountSelectionChange,
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ClaudeHostRunningSessionsMove } from '../../../../shared/agent-accounts/managed-account-types'
import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { antigravityAccountSwitchCopy } from './account-switch-copy'
import {
  announceAccountRestart,
  announceHostAccountMove,
  dismissHostAskToast
} from './account-switch-toasts'
import {
  createAccountSwitchPromptStore,
  currentPtyIds,
  pickedSwitchSessions,
  type AccountSwitchPrompt,
  type AccountSwitchPromptAnswer,
  type AccountSwitchPromptSessions,
  type AccountSwitchSessionCandidate
} from './account-switch-prompt'

let switchGeneration = 0
const promptStore = createAccountSwitchPromptStore<AccountSwitchPrompt>()
export const getAntigravityAccountSwitchPrompt = promptStore.get
export const subscribeAntigravityAccountSwitchPrompt = promptStore.subscribe

export function readAntigravityRunningSessionsPolicy(
  madeElsewhere?: true
): ClaudeAccountSwitchRunningSessions {
  const policy = useAppStore.getState().settings?.antigravityAccountSwitchRunningSessions ?? 'ask'
  // Why: no one at the CLI or another client sees a dialog here.
  return policy === 'ask' && madeElsewhere ? 'restart' : policy
}

function queueAntigravityRestarts(ptyIds: string[]): void {
  useAppStore.getState().queuePaneAccountRestarts(ptyIds, 'antigravity')
}

/** Answers the open dialog. "Don't ask again" only turns restarts on, as Claude's does. */
export const answerAntigravityAccountSwitchPrompt: AccountSwitchPromptAnswer = (
  answer,
  options = {}
) => {
  const request = promptStore.get()
  if (!request) {
    return
  }
  promptStore.set(null)
  if (answer === 'restart') {
    queueAntigravityRestarts(currentPtyIds(pickedSwitchSessions(request.sessions, options.ptyIds)))
  }
  if (options.dontAskAgain) {
    void useAppStore
      .getState()
      .updateSettings({ antigravityAccountSwitchRunningSessions: 'restart' })
  }
}

export function antigravityAccountLabel(
  accountId: string | null,
  emails: Readonly<Record<string, string>>
): string {
  if (accountId === null) {
    return translate('accounts.antigravity.switchSessions.unsavedLogin', "agy's earlier login")
  }
  return emails[accountId] ?? translate('accounts.antigravity.saved', 'Saved Google account')
}

/** The pane in this window bound to `ptyId`, if any. */
function findPane(state: AppState, ptyId: string): AccountSwitchSessionCandidate | null {
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    for (const tab of tabs) {
      if (!(state.ptyIdsByTabId[tab.id] ?? []).includes(ptyId)) {
        continue
      }
      const leaves = state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      const leafId = Object.keys(leaves).find((leaf) => leaves[leaf] === ptyId)
      return leafId && isTerminalLeafId(leafId)
        ? { ptyId, worktreeId, tabId: tab.id, leafId }
        : null
    }
  }
  return null
}

/** After agy's login switched on this window's host: the host listed its terminals still running
 *  agy on another account, and this window restarts the ones it shows, as the setting says.
 *  'show-confirmation' leaves the caller's switch toast. */
export function handleRunningAntigravityTerminalsAfterSwitch(
  change: AntigravityAccountSelectionChange,
  /** Switched from the CLI or another client, where no one can answer a dialog in this window. */
  madeElsewhere?: true
): 'show-confirmation' | 'handled' {
  const generation = ++switchGeneration
  promptStore.set(null)
  dropRestartsOnSelectedAccount(change)
  const policy = readAntigravityRunningSessionsPolicy(madeElsewhere)
  if (policy === 'keep') {
    return 'show-confirmation'
  }
  const state = useAppStore.getState()
  const sessions: AccountSwitchPromptSessions = { onAccount: [], elsewhere: [], cantMove: [] }
  const unheld: string[] = []
  for (const terminal of change.terminals) {
    const pane = findPane(state, terminal.ptyId)
    if (!pane) {
      unheld.push(terminal.ptyId)
      continue
    }
    if (terminal.accountId !== change.previousAccountId) {
      sessions.elsewhere.push({
        ...pane,
        accountLabel: antigravityAccountLabel(terminal.accountId, change.accountEmails)
      })
      continue
    }
    const shellOverride = state.tabsByWorktree[pane.worktreeId]?.find(
      (tab) => tab.id === pane.tabId
    )?.shellOverride
    const resumable = resolveAgentAccountRestartResumeStartup('antigravity', {
      ...pane,
      ...(shellOverride ? { shellOverride } : {})
    })
    // Why a reason, not a refusal: agy restarts fine without its conversation, only fresh.
    sessions.onAccount.push(resumable ? pane : { ...pane, reason: 'new-conversation' })
  }
  const previousAccountLabel = antigravityAccountLabel(
    change.previousAccountId,
    change.accountEmails
  )
  const nextAccountLabel = antigravityAccountLabel(change.accountId, change.accountEmails)
  moveUnheldTerminals(change, unheld, policy, {
    previous: previousAccountLabel,
    next: nextAccountLabel
  })
  // Why: terminals kept on another account are listed only alongside a move, as Claude's are.
  if (sessions.onAccount.length === 0) {
    return 'show-confirmation'
  }
  if (policy === 'restart') {
    queueAntigravityRestarts(sessions.onAccount.map((session) => session.ptyId))
    const review =
      sessions.elsewhere.length > 0
        ? () => {
            if (generation === switchGeneration) {
              promptStore.set({
                id: generation,
                review: true,
                sessions: { ...sessions, onAccount: [] },
                previousAccountLabel,
                nextAccountLabel
              })
            }
          }
        : undefined
    announceAccountRestart(
      antigravityAccountSwitchCopy(),
      sessions.onAccount.length,
      nextAccountLabel,
      sessions.elsewhere.length,
      review,
      sessions.onAccount.filter((session) => session.reason).length
    )
    return 'handled'
  }
  promptStore.set({ id: generation, sessions, previousAccountLabel, nextAccountLabel })
  return 'handled'
}

/** An accepted restart relaunches on whatever is selected when it runs; one for a terminal the
 *  host no longer lists (back on the selected account, or out of agy) must not run at all. */
function dropRestartsOnSelectedAccount(change: AntigravityAccountSelectionChange): void {
  const store = useAppStore.getState()
  const listed = new Set(change.terminals.map((terminal) => terminal.ptyId))
  for (const [ptyId, agent] of Object.entries(store.pendingPaneAccountRestarts)) {
    if (agent === 'antigravity' && !listed.has(ptyId)) {
      store.consumePendingPaneAccountRestart(ptyId)
    }
  }
}

/** Terminals the host listed that no pane here shows, such as an agy a background launch started
 *  in a workspace this window never opened: the host moves them by this window's rule. */
function moveUnheldTerminals(
  change: AntigravityAccountSelectionChange,
  ptyIds: readonly string[],
  policy: ClaudeAccountSwitchRunningSessions,
  labels: { previous: string; next: string }
): void {
  if (ptyIds.length === 0) {
    return
  }
  const local: RuntimeClientTarget = { kind: 'local' }
  void callRuntimeRpc<ClaudeHostRunningSessionsMove | undefined>(
    local,
    'accounts.antigravityMoveUnheldTerminals',
    {
      previousAccountId: change.previousAccountId,
      accountId: change.accountId,
      ptyIds,
      runningSessions: policy
    },
    { timeoutMs: 30_000 }
  ).then(
    (move) =>
      announceHostAccountMove(
        antigravityAccountSwitchCopy(),
        move ?? undefined,
        labels,
        () => answerHostAsk(local, change.accountId),
        replaceHostAsk(local)
      ),
    (error: unknown) =>
      console.warn(
        '[antigravity-account-switch] could not move terminals this window lacks:',
        error
      )
  )
}

/** Answers the Ask the host left open; it does nothing once a later switch has replaced it. */
async function answerHostAsk(
  owner: RuntimeClientTarget,
  accountId: string,
  target: AntigravityAccountTarget = { runtime: 'host' }
): Promise<ClaudeHostRunningSessionsMove | undefined> {
  const reply = await callRuntimeRpc<AntigravityAccountSelectResult>(
    owner,
    'accounts.antigravitySelect',
    { target, accountId, answersAsk: true },
    { timeoutMs: 30_000 }
  )
  return reply.runningSessions
}

function savedAccountLabel(
  state: AntigravityAccountState | null,
  accountId: string | null
): string {
  const account = state?.accounts.find((entry) => entry.id === accountId)
  return accountId === null
    ? antigravityAccountLabel(null, {})
    : (account?.email ??
        account?.subject ??
        translate('accounts.antigravity.saved', 'Saved Google account'))
}

/** What a select's reply says about the host's running agy terminals: this window's to restart, or
 *  what a server did with its own. 'show-confirmation' leaves the caller's switch toast. */
export function handleRunningAntigravityTerminalsAfterSelect(args: {
  owner: RuntimeClientTarget
  target: AntigravityAccountTarget
  previous: AntigravityAccountState | null
  next: AntigravityAccountSelectResult
  accountId: string
}): 'show-confirmation' | 'handled' {
  const { owner, target, next, accountId } = args
  if (next.runningTerminals) {
    return handleRunningAntigravityTerminalsAfterSwitch(next.runningTerminals)
  }
  return announceHostAccountMove(
    antigravityAccountSwitchCopy(),
    next.runningSessions,
    {
      previous: savedAccountLabel(args.previous, args.previous?.selectedAccountId ?? null),
      next: savedAccountLabel(next, accountId)
    },
    () => answerHostAsk(owner, accountId, target),
    replaceHostAsk(owner)
  )
}

/** One host Ask toast per host: each switch there replaces the last one's. */
function replaceHostAsk(owner: RuntimeClientTarget): string {
  const toastId = `antigravity-account-switch-host-ask:${
    owner.kind === 'local' ? 'local' : `environment:${owner.environmentId}`
  }`
  dismissHostAskToast(toastId)
  return toastId
}
