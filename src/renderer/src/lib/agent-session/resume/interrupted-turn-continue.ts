// A remote host that restarts under a terminal agent mid-turn kills the turn; the relaunched agent
// resumes its session but waits. Carry the turn on by itself: agents that were working when the
// restart began get `continue` once their relaunched TUI is ready for input. Host-agnostic (works
// whichever path relaunched the agent), once per interrupted turn, and never when the agent is
// already working again (another path continued it). Armed only by a restart or rollover, never by
// a sleep: those are the restarts that cut a working turn. (A pane's sleeping record is no signal
// here: it can outlive the wake that resumed the agent.)
import { useAppStore } from '@/store'
import { offerInterruptedTurnContinue } from './interrupted-turn-continue-offer'
import { getPtyIdForPaneKey } from '@/hooks/pane-key-pty-id'
import { sendFollowupPromptWhenAgentReady } from '@/lib/agent-session/messaging/paste/agent-followup-delivery'
import { sendBracketedPasteToRunningAgent } from '@/lib/agent-session/messaging/paste/agent-paste-draft'
import { TUI_AGENT_CONFIG } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { isResumableTuiAgent } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { INTERRUPTED_TURN_CONTINUE_PROMPT } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import {
  interruptedTurnKey,
  isInterruptedTurnContinued,
  markInterruptedTurnContinued
} from '@/components/terminal-pane/pty-connection/startup/cold-restore-resume-startup'
import {
  paneHadUserInputSince,
  workspaceHadUserInputSince
} from '@/components/terminal-pane/input/wake-input-buffer'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../../../shared/agent-status/process/agent-process-recognition'

type ArmedTurn = {
  workspaceId: string
  /** The agent session that was working: a late relaunch must resume this one, not a new one. */
  providerSessionId: string | null
  paneKey: string
  agent: TuiAgent
  turnKey: string
  armedAt: number
  /** The terminal the agent ran in when armed: only a report from a different one is the relaunch. */
  terminalHandle: string | null
  /** The pane's PTY when armed (the relaunch may reuse the id; it is only a hint). */
  ptyIdAtArm: string | null
  /** This pane's arm generation; a newer arm or a disarm makes this loop stale. */
  generation?: number
  /** Set by continueInterruptedTurns: the restart this turn was armed for has settled. */
  settledAt?: number
}

/** How long after its pane is open a relaunched agent may take to come up. */
const RELAUNCH_WAIT_MS = 90_000
const POLL_MS = 1_000
/**
 * A pane that isn't open relaunches its agent only when the user reopens it (the agent view or the
 * workspace), possibly long after the restart. Keep the turn armed until then, as long as the
 * turn is still fresh (the same bound the cold-restore continue uses), polling slowly meanwhile.
 */
const CLOSED_PANE_POLL_MS = 5_000
/** A relaunched agent's TUI keeps drawing briefly after its first hook fires. */
const SETTLE_AFTER_REPORT_MS = 2_000

const armedByWorkspace = new Map<string, ArmedTurn[]>()
/** Panes whose continue loop is running, per workspace: a disarm (e.g. a sleep) must reach them. */
const runningByWorkspace = new Map<string, Set<string>>()
/** Bumped by every arm/disarm of a pane: an older wait loop for that pane stops at its next step. */
const paneGeneration = new Map<string, number>()
const bumpPane = (paneKey: string): number => {
  const next = (paneGeneration.get(paneKey) ?? 0) + 1
  paneGeneration.set(paneKey, next)
  return next
}
/** A relaunch first seen this long after the restart is "late": the person reopened the pane. */

/** Dev builds only: what the continue logic decided, for e2e drivers (window.__orcaContinueTrace). */
const devTrace: string[] | null = import.meta.env?.DEV && typeof window !== 'undefined' ? [] : null
if (devTrace) {
  Reflect.set(window, '__orcaContinueTrace', devTrace)
}
function trace(event: string): void {
  devTrace?.push(`${Date.now()} ${event}`)
}
const sentTurns = new Set<string>()

type StatusEntry = {
  state: string
  updatedAt: number
  stateStartedAt?: number
  agentType?: string
  worktreeId?: string
  tabId?: string
  paneKey: string
  terminalHandle?: string
  providerSession?: { id?: string }
}

function paneWorkspaceId(entry: StatusEntry, tabWorkspace: Map<string, string>): string | null {
  if (entry.worktreeId) {
    return entry.worktreeId
  }
  const tabId = entry.tabId ?? entry.paneKey.split(':')[0]
  return tabId ? (tabWorkspace.get(tabId) ?? null) : null
}

/** Snapshot the agents working in this workspace as its host restart begins. */
export function armInterruptedTurnsForHostRestart(workspaceId: string, now = Date.now()): number {
  const state = useAppStore.getState()
  const tabWorkspace = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    for (const tab of tabs ?? []) {
      tabWorkspace.set(tab.id, worktreeId)
    }
  }
  const armed: ArmedTurn[] = []
  for (const entry of Object.values<StatusEntry | undefined>(state.agentStatusByPaneKey ?? {})) {
    const agent = entry?.agentType
    if (
      !entry ||
      entry.state !== 'working' ||
      now - entry.updatedAt > AGENT_STATUS_STALE_AFTER_MS ||
      !isResumableTuiAgent(agent) ||
      paneWorkspaceId(entry, tabWorkspace) !== workspaceId
    ) {
      continue
    }
    armed.push({
      workspaceId,
      providerSessionId: entry.providerSession?.id ?? null,
      paneKey: entry.paneKey,
      agent,
      turnKey: interruptedTurnKey(entry, entry.paneKey),
      armedAt: now,
      terminalHandle: entry.terminalHandle ?? null,
      ptyIdAtArm: getPtyIdForPaneKey(entry.paneKey)
    })
  }
  trace(
    `arm ${workspaceId.slice(-12)} ${armed.map((turn) => `${turn.agent}:${turn.paneKey.slice(-4)}`).join(',')}`
  )
  for (const turn of armedByWorkspace.get(workspaceId) ?? []) {
    bumpPane(turn.paneKey)
  }
  for (const turn of armed) {
    turn.generation = bumpPane(turn.paneKey)
  }
  if (armed.length > 0) {
    armedByWorkspace.set(workspaceId, armed)
  } else {
    armedByWorkspace.delete(workspaceId)
  }
  return armed.length
}

/** The restart failed or was abandoned: forget what was armed. */
export function disarmInterruptedTurns(workspaceId: string): void {
  for (const turn of armedByWorkspace.get(workspaceId) ?? []) {
    bumpPane(turn.paneKey)
  }
  for (const paneKey of runningByWorkspace.get(workspaceId) ?? []) {
    bumpPane(paneKey)
  }
  armedByWorkspace.delete(workspaceId)
}

function statusSince(paneKey: string, armedAt: number): StatusEntry | null {
  const entry: StatusEntry | undefined = useAppStore.getState().agentStatusByPaneKey[paneKey]
  return entry && entry.updatedAt > armedAt ? entry : null
}

/** A report from the relaunched agent: newer than the restart and not from the terminal that died. */
function relaunchReport(turn: ArmedTurn): StatusEntry | null {
  const entry = statusSince(turn.paneKey, turn.armedAt)
  if (!entry) {
    return null
  }
  // The old process can report its own interruption while dying; that is not the relaunch.
  if (turn.terminalHandle && entry.terminalHandle === turn.terminalHandle) {
    return null
  }
  return entry
}

function leafOf(paneKey: string): string {
  return paneKey.slice(paneKey.lastIndexOf(':') + 1)
}

function continuedOnItsOwn(paneKey: string, armedAt: number): boolean {
  const entry = statusSince(paneKey, armedAt)
  // Working again with evidence newer than the restart: some other path already carried it on.
  return entry?.state === 'working' && (entry.stateStartedAt ?? entry.updatedAt) > armedAt
}

async function continueOne(turn: ArmedTurn, deps: ContinueDeps): Promise<boolean> {
  if (sentTurns.has(turn.turnKey)) {
    return false
  }
  const freshUntil = turn.armedAt + AGENT_STATUS_STALE_AFTER_MS
  const settledAt = turn.settledAt ?? deps.now()
  // Starts when the pane is (re)opened: only then can its agent relaunch and read input.
  let relaunchDeadline: number | null = null
  const stale = (): boolean =>
    turn.generation !== undefined && paneGeneration.get(turn.paneKey) !== turn.generation
  const userTookOver = (): boolean =>
    isInterruptedTurnContinued(turn.turnKey) ||
    paneHadUserInputSince(leafOf(turn.paneKey), turn.armedAt)
  while (deps.now() < Math.min(freshUntil, relaunchDeadline ?? freshUntil)) {
    if (stale()) {
      return false
    }
    if (
      continuedOnItsOwn(turn.paneKey, turn.armedAt) ||
      // A cold-restore resume already carried `continue`, or a person typed into the pane since.
      isInterruptedTurnContinued(turn.turnKey) ||
      paneHadUserInputSince(leafOf(turn.paneKey), turn.armedAt)
    ) {
      return false
    }
    const ptyId = deps.ptyIdFor(turn.paneKey)
    if (!ptyId) {
      // Not open: wait for the user to reopen it instead of giving up after the relaunch window.
      relaunchDeadline = null
      await deps.sleep(CLOSED_PANE_POLL_MS)
      continue
    }
    relaunchDeadline ??= deps.now() + RELAUNCH_WAIT_MS
    // Reopened long after the restart settled: the person may only want to read. Continue only the
    // same agent session, and only if nobody has done anything in the workspace since; otherwise
    // leave an offer instead of typing into it.
    if (deps.now() - settledAt > RELAUNCH_WAIT_MS) {
      if (!relaunchReport(turn)) {
        // Can't tell which session came back until the relaunched agent reports.
        await deps.sleep(POLL_MS)
        continue
      }
      if (!lateContinueAllowed(turn)) {
        deps.offer?.(turn)
        return false
      }
    }
    // The relaunched agent already reported (its hooks only run inside the agent), so its TUI is
    // up and reading input: submit once it has settled and owns the terminal. Some agents (Codex)
    // resume idle and never emit the paste-readiness signal the generic path waits for.
    const reported = relaunchReport(turn)
    if (reported) {
      trace(
        `reported ${turn.paneKey.slice(-4)} ${reported.state} age=${deps.now() - reported.updatedAt}`
      )
      if (
        deps.now() - reported.updatedAt >= SETTLE_AFTER_REPORT_MS &&
        (await deps.agentInForeground(ptyId, turn.agent)) &&
        !stale() &&
        !userTookOver() &&
        (await deps.submit({
          ptyId,
          content: INTERRUPTED_TURN_CONTINUE_PROMPT
        }))
      ) {
        sentTurns.add(turn.turnKey)
        markInterruptedTurnContinued(turn.turnKey)
        return true
      }
    } else if (!stale() && !userTookOver()) {
      const sent = await deps.send({
        ptyId,
        agent: turn.agent,
        expectedProcess: TUI_AGENT_CONFIG[turn.agent].expectedProcess,
        prompt: INTERRUPTED_TURN_CONTINUE_PROMPT
      })
      if (sent) {
        sentTurns.add(turn.turnKey)
        markInterruptedTurnContinued(turn.turnKey)
        return true
      }
    }
    await deps.sleep(POLL_MS)
  }
  return false
}

/** A late relaunch: the same agent session (resume, not a new chat) and no activity since. */
function lateContinueAllowed(turn: ArmedTurn): boolean {
  if (workspaceHadUserInputSince(turn.workspaceId, turn.armedAt)) {
    return false
  }
  const report = relaunchReport(turn)
  const sessionId = report?.providerSession?.id ?? null
  return turn.providerSessionId !== null && sessionId === turn.providerSessionId
}

type ContinueDeps = {
  now: () => number
  sleep: (ms: number) => Promise<void>
  ptyIdFor: (paneKey: string) => string | null
  send: typeof sendFollowupPromptWhenAgentReady
  submit: typeof sendBracketedPasteToRunningAgent
  /** The relaunched agent (not a shell) is the terminal's foreground process. */
  agentInForeground: (ptyId: string, agent: TuiAgent) => Promise<boolean>
  /** Late reopen that may not be typed into: offer "Continue" instead. */
  offer?: (turn: ArmedTurn) => void
}

async function agentOwnsTerminal(ptyId: string, agent: TuiAgent): Promise<boolean> {
  try {
    const foreground = (await inspectRuntimeTerminalProcess(ptyId)).foregroundProcess ?? ''
    return (
      isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess) ||
      isAgentForegroundWrapperProcess(foreground)
    )
  } catch {
    return false
  }
}

const defaultDeps: ContinueDeps = {
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ptyIdFor: getPtyIdForPaneKey,
  send: sendFollowupPromptWhenAgentReady,
  submit: sendBracketedPasteToRunningAgent,
  agentInForeground: agentOwnsTerminal,
  offer: (turn) => offerInterruptedTurnContinue(turn.paneKey, turn.turnKey)
}

/** The host is back: send `continue` to every armed agent once its relaunched TUI reads input. */
export async function continueInterruptedTurns(
  workspaceId: string,
  deps: ContinueDeps = defaultDeps
): Promise<number> {
  const armed = armedByWorkspace.get(workspaceId)
  armedByWorkspace.delete(workspaceId)
  if (!armed?.length) {
    return 0
  }
  trace(`continue ${workspaceId.slice(-12)} ${armed.length}`)
  const settledAt = deps.now()
  for (const turn of armed) {
    turn.settledAt = settledAt
  }
  const running = runningByWorkspace.get(workspaceId) ?? new Set<string>()
  runningByWorkspace.set(workspaceId, running)
  for (const turn of armed) {
    running.add(turn.paneKey)
  }
  const results = await Promise.all(
    armed.map((turn) =>
      continueOne(turn, deps)
        .finally(() => {
          running.delete(turn.paneKey)
          if (running.size === 0 && runningByWorkspace.get(workspaceId) === running) {
            runningByWorkspace.delete(workspaceId)
          }
        })
        .then((sent) => (trace(`result ${turn.paneKey.slice(-4)} ${sent}`), sent))
        .catch(
          (error: unknown) => (trace(`error ${turn.paneKey.slice(-4)} ${String(error)}`), false)
        )
    )
  )
  return results.filter(Boolean).length
}

/** Tests only. */
export function resetInterruptedTurnContinueForTests(): void {
  armedByWorkspace.clear()
  runningByWorkspace.clear()
  sentTurns.clear()
  paneGeneration.clear()
}
