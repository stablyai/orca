import { useAppStore } from '@/store/index'
import type { CodexAccountSelectionTarget } from '../../../../shared/codex-selection-lane'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/claude-account-switch-settings'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getClaudeAccountLabel } from './claude-account-label'
import {
  announceRestart,
  warnSessionsLeftBehind,
  warnSharedSessions,
  warnUncheckedSessions
} from './claude-account-switch-notices'
import {
  recordClaudeAccountSwitchBreadcrumb,
  type ClaudeAccountSwitchRecord
} from './claude-account-switch-breadcrumb'
import {
  recordQueuedClaudeRestarts,
  type ClaudePaneLookups
} from '../agent-session/accounts/claude/claude-queued-restart-records'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { redactPtyIdForDiagnostics } from '../../../../shared/terminal/pty/diagnostics/pty-delivery-diagnostics'
import type { ClaudeHostFolders } from '../agent-session/accounts/claude/claude-pane-account-folder'
import { settleQueuedClaudeRestarts } from '../agent-session/accounts/claude/claude-pane-session-lookup'
import {
  claudeLaunchAccountId,
  findClaudeSwitchSessions,
  type ClaudeSessionMoveCandidate,
  type ClaudeSwitchSessions
} from '../agent-session/accounts/claude/claude-session-account-move'

export type ClaudeAccountSwitchPromptSessions = {
  onAccount: ClaudeSessionMoveCandidate[]
  elsewhere: (ClaudeSessionMoveCandidate & { accountLabel: string })[]
  cantMove: ClaudeSwitchSessions['cantMove']
  lookups: ClaudePaneLookups
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

function queueClaudeRestarts(
  ptyIds: string[],
  restartAll: boolean,
  lookups: ClaudePaneLookups
): void {
  const { terminalLayoutsByTabId: layouts, agentStatusByPaneKey } = useAppStore.getState()
  const sessions = new Map(
    Object.entries(layouts).flatMap(([tabId, layout]) =>
      Object.entries(layout?.ptyIdsByLeafId ?? {}).flatMap(([leafId, ptyId]) => {
        const paneKey = makePaneKey(tabId, leafId)
        const session = lookups.get(paneKey)
        const hooked = normalizeAgentProviderSession(agentStatusByPaneKey[paneKey]?.providerSession)
        return ptyId && session && !hooked ? [[ptyId, session] as const] : []
      })
    )
  )
  recordQueuedClaudeRestarts(ptyIds, restartAll, sessions)
  useAppStore.getState().queuePaneAccountRestarts(ptyIds, 'claude')
}

/** Why now: a reattach can rebind a pane during the scan or while the dialog is open, and a closed pane has none. */
function currentPtyIds(
  sessions: readonly ClaudeSessionMoveCandidate[],
  requireLive = false
): string[] {
  const { terminalLayoutsByTabId: layouts, ptyIdsByTabId } = useAppStore.getState()
  return sessions.flatMap((session) => {
    const ptyId = layouts[session.tabId]?.ptyIdsByLeafId?.[session.leafId]
    return ptyId && (!requireLive || ptyIdsByTabId[session.tabId]?.includes(ptyId)) ? [ptyId] : []
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
    queueClaudeRestarts(currentPtyIds(picked), false, request.sessions.lookups)
  }
  if (options.dontAskAgain) {
    void useAppStore.getState().updateSettings({ claudeAccountSwitchRunningSessions: 'restart' })
  }
}

export type ClaudeAccountSnapshot = {
  state: ClaudeHostFolders
  accountId: string | null
}

type ClaudeAccountSwitch = {
  owner: RuntimeClientTarget
  target: CodexAccountSelectionTarget
  before: ClaudeAccountSnapshot
  after: ClaudeAccountSnapshot
  /** Switched from a phone or the CLI, where no one can answer a dialog on this computer. */
  madeElsewhere?: true
}

/** After account selection applies, ask/restart/retain sessions on the outgoing account; show-confirmation leaves the caller’s toast. */
export async function handleRunningClaudeSessionsAfterSwitch(
  args: ClaudeAccountSwitch
): Promise<'show-confirmation' | 'handled'> {
  const record: ClaudeAccountSwitchRecord = {
    policy: readPolicy(args.madeElsewhere),
    madeElsewhere: args.madeElsewhere,
    fromAccountId: claudeLaunchAccountId(args.before.state, args.before.accountId),
    toAccountId: claudeLaunchAccountId(args.after.state, args.after.accountId)
  }
  const result = await moveSessionsAfterSwitch(args, record)
  recordClaudeAccountSwitchBreadcrumb(args.owner.kind === 'local', record, result)
  return result
}

async function moveSessionsAfterSwitch(
  args: ClaudeAccountSwitch,
  record: ClaudeAccountSwitchRecord
): Promise<'show-confirmation' | 'handled'> {
  const { fromAccountId, toAccountId, policy } = record
  const restartAll = policy === 'restart-all'
  // Why: a server's switch, or one between coinciding launch folders, moves nothing here.
  if (args.owner.kind !== 'local' || fromAccountId === toAccountId) {
    return 'show-confirmation'
  }
  const generation = ++switchGeneration
  setPrompt(null)
  // Why the new list: main read its folders and logins as it applied the switch.
  const host = args.after.state
  const nextAccountLabel = getClaudeAccountLabel(args.after.state, args.after.accountId)
  // Why: an accepted restart relaunches on whatever is selected when it runs, so it outlives switches.
  const discovered = await settleQueuedClaudeRestarts({
    owner: args.owner,
    target: args.target,
    accountId: toAccountId,
    host,
    accountLabel: nextAccountLabel,
    isCurrent: () => generation === switchGeneration,
    restartAll
  })
  record.lookups = discovered
  if (policy === 'keep') {
    return 'show-confirmation'
  }
  let uncheckedCount = 0
  let uncheckedOthersCount = 0
  let sharedCount = 0
  const found = await findClaudeSwitchSessions({
    owner: args.owner,
    target: args.target,
    fromAccountId,
    toAccountId,
    host,
    restartAll,
    discovered,
    onUnchecked: (sessions) => {
      uncheckedCount = sessions.length
      console.warn(
        '[claude-account-switch] could not read the foreground of',
        sessions.map((session) => redactPtyIdForDiagnostics(session.ptyId))
      )
    },
    onUncheckedOthers: (sessions) => {
      uncheckedOthersCount = sessions.length
    },
    onShared: (sessions) => {
      sharedCount = sessions.length
    },
    onInspected: (panes, inspected) => {
      record.panes = panes
      record.inspected = inspected
    }
  }).catch((error: unknown) => {
    console.warn('[claude-account-switch] session scan failed:', error)
    return null
  })
  if (generation !== switchGeneration) {
    return 'handled'
  }
  if (uncheckedCount > 0) {
    warnUncheckedSessions(
      uncheckedCount,
      getClaudeAccountLabel(args.before.state, args.before.accountId)
    )
  }
  const queued =
    found && restartAll
      ? currentPtyIds([...found.onAccount, ...found.elsewhere], true)
      : currentPtyIds(found?.onAccount ?? [])
  record.found = found
  record.queued = policy === 'ask' ? [] : queued
  // Why: other sessions are listed only alongside a move, so parallel-account users get no prompt.
  if (!found || queued.length === 0) {
    if (sharedCount > 0) {
      warnSharedSessions(
        sharedCount,
        getClaudeAccountLabel(args.before.state, args.before.accountId)
      )
    }
    // Why less shared: the warning above already named the outgoing account's shared sessions.
    const leftBehind = (found?.cantMove.length ?? 0) - sharedCount + uncheckedOthersCount
    if (restartAll && leftBehind > 0) {
      warnSessionsLeftBehind(leftBehind, nextAccountLabel)
    }
    return 'show-confirmation'
  }
  if (restartAll) {
    queueClaudeRestarts(queued, true, discovered)
    announceRestart(queued.length, nextAccountLabel, found.cantMove.length + uncheckedOthersCount)
    return 'handled'
  }
  const sessions: ClaudeAccountSwitchPromptSessions = {
    ...found,
    elsewhere: found.elsewhere.map((session) => ({
      ...session,
      accountLabel: getClaudeAccountLabel(args.after.state, session.accountId)
    })),
    lookups: discovered
  }
  const labels = {
    previousAccountLabel: getClaudeAccountLabel(args.before.state, args.before.accountId),
    nextAccountLabel
  }
  if (policy === 'restart') {
    queueClaudeRestarts(queued, false, discovered)
    const listed = found.elsewhere.length + found.cantMove.length
    const review = (): void => {
      if (generation === switchGeneration) {
        setPrompt({
          id: generation,
          review: true,
          sessions: { ...sessions, onAccount: [] },
          ...labels
        })
      }
    }
    const others = listed + uncheckedOthersCount
    announceRestart(queued.length, nextAccountLabel, others, listed > 0 ? review : undefined)
    return 'handled'
  }
  setPrompt({ id: generation, sessions, ...labels })
  return 'handled'
}

function readPolicy(madeElsewhere?: true): ClaudeAccountSwitchRunningSessions {
  const policy = useAppStore.getState().settings?.claudeAccountSwitchRunningSessions ?? 'ask'
  // Why: no one at the phone sees a dialog here; restarts still wait for each turn to end.
  return policy === 'ask' && madeElsewhere ? 'restart' : policy
}

export function resetClaudeAccountSwitchSessionsForTests(): void {
  switchGeneration = 0
  setPrompt(null)
}
