import type { TuiAgent } from '../../../shared/tui-agent'
import {
  agentSessionRestartSessionMatches,
  selectAgentSessionRestartTargets,
  type AgentSessionRestartFence,
  type AgentSessionRestartPlan,
  type AgentSessionRestartTarget
} from './agent-session-restart-plan'
import {
  agentSessionRestartChangedMessage,
  agentSessionRestartRemovedMessage,
  type AgentSessionRestartOutcome
} from './agent-session-restart-run'

export type AgentSessionRestartControllerSnapshot = {
  outcomes: readonly AgentSessionRestartOutcome[]
  running: boolean
}

export type AgentSessionRestartController = {
  getSnapshot: () => AgentSessionRestartControllerSnapshot
  subscribe: (listener: () => void) => () => void
  request: (agent: TuiAgent | 'all', ptyIds?: readonly string[]) => Promise<void>
  dismiss: () => void
  promote: () => Promise<void>
  hasWaiting: () => boolean
  isRunning: () => boolean
}

type FencedTarget = Extract<AgentSessionRestartTarget, { fence: AgentSessionRestartFence }>

export function createAgentSessionRestartController(deps: {
  plan: () => AgentSessionRestartPlan
  run: (targets: readonly AgentSessionRestartTarget[]) => Promise<AgentSessionRestartOutcome[]>
}): AgentSessionRestartController {
  let outcomes: AgentSessionRestartOutcome[] = []
  const waiting = new Map<string, FencedTarget>()
  let running = false
  let promoteAgain = false
  const listeners = new Set<() => void>()
  let snapshot: AgentSessionRestartControllerSnapshot = { outcomes, running }

  const publish = (): void => {
    snapshot = { outcomes, running }
    for (const listener of listeners) {
      listener()
    }
  }

  const seedWaiting = (submitted: readonly AgentSessionRestartTarget[]): void => {
    for (const target of submitted) {
      if (
        (target.kind === 'queued' || target.kind === 'restart') &&
        !waiting.has(target.pane.ptyId)
      ) {
        waiting.set(target.pane.ptyId, target)
      }
    }
  }

  const rememberWaiting = (
    submitted: readonly AgentSessionRestartTarget[],
    next: readonly AgentSessionRestartOutcome[]
  ): void => {
    const submittedByPty = new Map(submitted.map((target) => [target.pane.ptyId, target]))
    for (const outcome of next) {
      if (outcome.status !== 'queued' && outcome.status !== 'pending') {
        waiting.delete(outcome.ptyId)
        continue
      }
      if (waiting.has(outcome.ptyId)) {
        continue
      }
      const target = submittedByPty.get(outcome.ptyId)
      if (target && 'fence' in target) {
        waiting.set(outcome.ptyId, target)
      }
    }
  }

  const mergeOutcomes = (
    submitted: readonly AgentSessionRestartTarget[],
    next: readonly AgentSessionRestartOutcome[]
  ): void => {
    const byPty = new Map(outcomes.map((outcome) => [outcome.ptyId, outcome]))
    for (const outcome of next) {
      byPty.set(outcome.ptyId, outcome)
    }
    outcomes = [...byPty.values()]
    rememberWaiting(submitted, next)
  }

  function keepOriginalFence(target: AgentSessionRestartTarget): AgentSessionRestartTarget {
    const prior = waiting.get(target.pane.ptyId)
    if (!prior) {
      return target
    }
    if (!agentSessionRestartSessionMatches(prior.fence, target.pane)) {
      return {
        pane: target.pane,
        label: target.label,
        workspaceLabel: target.workspaceLabel,
        kind: 'skipped',
        reason: 'pane-changed'
      }
    }
    if (target.kind === 'restart' || target.kind === 'queued') {
      return { ...target, fence: prior.fence }
    }
    return target
  }

  async function finishRunning(): Promise<void> {
    running = false
    publish()
    if (!promoteAgain) {
      return
    }
    promoteAgain = false
    await promote()
  }

  async function request(agent: TuiAgent | 'all', ptyIds?: readonly string[]): Promise<void> {
    if (running) {
      promoteAgain = true
      return
    }
    outcomes = outcomes.filter((outcome) => waiting.has(outcome.ptyId))
    running = true
    publish()
    try {
      const selected = selectAgentSessionRestartTargets(deps.plan().targets, agent)
        .filter((target) => ptyIds === undefined || ptyIds.includes(target.pane.ptyId))
        .map(keepOriginalFence)
      seedWaiting(selected)
      mergeOutcomes(selected, await deps.run(selected))
    } catch (err) {
      console.warn('[session-restart] request failed:', err)
    } finally {
      await finishRunning()
    }
  }

  async function promote(): Promise<void> {
    if (running || waiting.size === 0) {
      if (running) {
        promoteAgain = true
      }
      return
    }
    running = true
    publish()
    try {
      const byPty = new Map(deps.plan().targets.map((target) => [target.pane.ptyId, target]))
      const rerun: AgentSessionRestartTarget[] = []
      const closed: AgentSessionRestartOutcome[] = []
      for (const [ptyId, prior] of waiting) {
        const current = byPty.get(ptyId)
        const previous = outcomes.find((outcome) => outcome.ptyId === ptyId)
        if (!current) {
          if (previous) {
            closed.push(closedOutcome(previous))
          }
          continue
        }
        if (!agentSessionRestartSessionMatches(prior.fence, current.pane)) {
          if (previous) {
            closed.push({
              ...previous,
              status: 'skipped',
              message: agentSessionRestartChangedMessage(),
              newPtyId: null,
              reapPtyId: null
            })
          }
          continue
        }
        if (current.kind === 'queued') {
          continue
        }
        rerun.push(current.kind === 'restart' ? { ...current, fence: prior.fence } : current)
      }
      const next = rerun.length > 0 ? await deps.run(rerun) : []
      mergeOutcomes(rerun, [...closed, ...next])
    } catch (err) {
      console.warn('[session-restart] promote failed:', err)
    } finally {
      await finishRunning()
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    request,
    dismiss: () => {
      if (running) {
        return
      }
      outcomes = outcomes.filter((outcome) => waiting.has(outcome.ptyId))
      publish()
    },
    promote,
    hasWaiting: () => waiting.size > 0,
    isRunning: () => running
  }
}

function closedOutcome(previous: AgentSessionRestartOutcome): AgentSessionRestartOutcome {
  return {
    ...previous,
    status: 'skipped',
    message: agentSessionRestartRemovedMessage(),
    newPtyId: null,
    reapPtyId: null
  }
}
