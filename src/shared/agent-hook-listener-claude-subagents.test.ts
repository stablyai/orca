import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearClaudeAnsweredQuestionWait,
  clearPaneCacheState,
  createHookListenerState,
  markClaudeLeadTurnInterrupted,
  normalizeHookPayload,
  seedClaudeSubagentRosterFromSnapshots,
  type HookListenerState
} from './agent-hook-listener'
import { clearGrokSessionPathLookupCacheForTests } from './grok-session-paths'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import { makePaneKey } from './stable-pane-id'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('shared agent-hook-listener', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  afterEach(() => {
    clearGrokSessionPathLookupCacheForTests()
    vi.unstubAllEnvs()
  })

  describe('claude subagent tracking', () => {
    const claudeEvent = (
      payload: Record<string, unknown>,
      paneKey: string = PANE_KEY
    ): ReturnType<typeof normalizeHookPayload> =>
      normalizeHookPayload(state, 'claude', { paneKey, payload }, 'production')

    it('keeps Stop as done when background_tasks is empty', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
      const stop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
      expect(stop?.payload.state).toBe('done')
      expect(stop?.payload.subagents).toBeUndefined()
      expect(stop?.payload.turnCompletedAt).toBeUndefined()
    })

    it('stamps turnCompletedAt on a gated lead Stop and repeats it on the all-clear', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(1_700_000_005_000)
        claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' })
        claudeEvent({
          hook_event_name: 'SubagentStart',
          agent_id: 'a1',
          agent_type: 'general-purpose'
        })
        const stop = claudeEvent({
          hook_event_name: 'Stop',
          last_assistant_message: 'Which cells need hand-verification?',
          background_tasks: [
            {
              id: 'a1',
              type: 'subagent',
              status: 'running',
              description: 'Review loop',
              agent_type: 'general-purpose'
            }
          ]
        })
        expect(stop?.payload.state).toBe('working')
        expect(stop?.payload.turnCompletedAt).toBe(1_700_000_005_000)
        expect(stop?.payload.lastAssistantMessage).toBe('Which cells need hand-verification?')

        vi.setSystemTime(1_700_000_055_000)
        const drained = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
        expect(drained?.payload.state).toBe('done')
        expect(drained?.payload.turnCompletedAt).toBe(1_700_000_005_000)

        claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'next turn' })
        const nextStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
        expect(nextStop?.payload.state).toBe('done')
        expect(nextStop?.payload.turnCompletedAt).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not stamp an interrupted Stop even while a child still gates the pane', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        is_interrupt: true,
        background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
      })
      expect(stop?.payload.state).toBe('working')
      expect(stop?.payload.turnCompletedAt).toBeUndefined()
    })

    it.each([
      {
        label: 'a running shell task',
        eventName: 'Stop',
        payload: { background_tasks: [{ id: 'shell-1', type: 'shell', status: 'running' }] }
      },
      {
        label: 'a pending session cron',
        eventName: 'StopFailure',
        payload: { session_crons: [{ id: 'cron-1' }] }
      }
    ])(
      'reports Stop as working for $label without adding a subagent row',
      ({ eventName, payload }) => {
        claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'run in background' })
        const stop = claudeEvent({ hook_event_name: eventName, ...payload })
        expect(stop?.payload.state).toBe('working')
        expect(stop?.payload.subagents).toBeUndefined()
      }
    )

    it('reports Stop as working while a background subagent is still running', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [
          {
            id: 'a1',
            type: 'subagent',
            status: 'running',
            description: 'Review loop',
            agent_type: 'general-purpose'
          }
        ]
      })
      expect(stop?.payload.state).toBe('working')
      expect(stop?.payload.subagents).toEqual([
        {
          id: 'a1',
          state: 'working',
          startedAt: expect.any(Number),
          agentType: 'general-purpose',
          description: 'Review loop'
        }
      ])

      // Why: the child finishing wakes the lead; its final Stop reports an
      // empty roster and the pane resolves to done with no child rows left.
      claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      const finalStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
      expect(finalStop?.payload.state).toBe('done')
      expect(finalStop?.payload.subagents).toBeUndefined()
    })

    it('emits a status refresh with the lead state on subagent lifecycle events', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'kick off reviewers' })
      claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })

      const spawned = claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'r1',
        agent_type: 'code-reviewer'
      })
      // Why: lead already stopped, but a live child means the pane is working.
      expect(spawned?.payload.state).toBe('working')
      expect(spawned?.payload.prompt).toBe('kick off reviewers')
      expect(spawned?.payload.subagents).toEqual([
        {
          id: 'r1',
          state: 'working',
          startedAt: expect.any(Number),
          agentType: 'code-reviewer',
          description: undefined
        }
      ])

      const stopped = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'r1' })
      expect(stopped?.payload.state).toBe('done')
      // Why: a finished one-shot leaves the sidebar instead of squatting as a
      // permanent idle row for the rest of the session.
      expect(stopped?.payload.subagents).toBeUndefined()
    })

    it('keeps gating on tracked children when background_tasks is absent (older Claude)', () => {
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      const stop = claudeEvent({ hook_event_name: 'Stop' })
      expect(stop?.payload.state).toBe('working')
      expect(stop?.payload.subagents).toEqual([expect.objectContaining({ id: 'a1' })])
    })

    it('marks subagent-origin tool events as child activity without adopting them as lead state', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })

      // Why: hook events from inside a subagent carry agent_id; they must keep
      // the child row live but not overwrite what the lead was last doing.
      const childTool = claudeEvent({
        hook_event_name: 'PreToolUse',
        agent_id: 'a9',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
      expect(childTool?.payload.state).toBe('working')
      expect(childTool?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'a9', state: 'working' })
      ])

      const stopped = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a9' })
      // Why: the lead's own last state was done, so with no working children
      // the pane settles back to done rather than a phantom working spinner.
      expect(stopped?.payload.state).toBe('done')
    })

    it('parks a teammate as a persistent idle row across its stop/idle/lead-Stop cycle', () => {
      // Why: the interactive agent-teams shape observed live on 2.1.217 —
      // lifecycle events use `a<name>-<hex>` agent ids while background_tasks
      // uses unrelated `type: "teammate"` task ids. SubagentStop + TeammateIdle
      // fire at every TURN end while the teammate stays alive awaiting mail,
      // so the row must park idle and survive lead Stops, not vanish.
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'spawn probe' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'aprobe1-6d3cb5b52120b7bf',
        agent_type: 'probe1'
      })
      const teammateTask = {
        id: 'tlkjjs0jv',
        type: 'teammate',
        status: 'running',
        description: 'Run the shell command: sleep 25.'
      }
      const spawnStop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [teammateTask]
      })
      expect(spawnStop?.payload.state).toBe('working')
      expect(spawnStop?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'aprobe1-6d3cb5b52120b7bf', state: 'working' })
      ])

      // Turn boundary: the row parks idle instead of leaving the sidebar.
      const stopped = claudeEvent({
        hook_event_name: 'SubagentStop',
        agent_id: 'aprobe1-6d3cb5b52120b7bf',
        agent_type: 'probe1',
        background_tasks: [teammateTask]
      })
      expect(stopped?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'aprobe1-6d3cb5b52120b7bf', state: 'idle' })
      ])

      claudeEvent({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'probe1',
        team_name: 'session-56c87269'
      })

      // The confirmed idle row survives the lead Stop (its teammate task is
      // still listed) without pinning the pane working.
      const wakeStop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [teammateTask]
      })
      expect(wakeStop?.payload.state).toBe('done')
      expect(wakeStop?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'aprobe1-6d3cb5b52120b7bf', state: 'idle' })
      ])
    })

    it('parks a working teammate via TeammateIdle when its id prefix matches the name', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'spawn reviewer' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'areviewer-6d3cb5b52120b7bf',
        agent_type: 'security-reviewer'
      })
      // Lead turn ends while the teammate works; pane stays working.
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'trev', type: 'teammate', status: 'running' }]
      })
      expect(stop?.payload.state).toBe('working')

      // Why: teammate name and agent type are separate Agent-tool inputs; the
      // lifecycle id embeds the former while the hook reports the latter.
      // TeammateIdle keyed by name parks it via the id prefix (fallback when
      // its SubagentStop was lost), so the pane settles back to the lead's
      // done state while the row stays visible as idle.
      const idled = claudeEvent({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'reviewer',
        team_name: 'session-x'
      })
      expect(idled?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'areviewer-6d3cb5b52120b7bf', state: 'idle' })
      ])
      expect(idled?.payload.state).toBe('done')
    })

    it('scopes subagent rosters per pane', () => {
      claudeEvent(
        { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' },
        PANE_KEY
      )
      const otherPane = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'other' }, otherPane)
      const otherStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] }, otherPane)
      expect(otherStop?.payload.state).toBe('done')
      expect(otherStop?.payload.subagents).toBeUndefined()
    })

    it('clears roster state when the pane cache is cleared', () => {
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      clearPaneCacheState(state, PANE_KEY)
      const stop = claudeEvent({ hook_event_name: 'Stop' })
      expect(stop?.payload.state).toBe('done')
      expect(stop?.payload.subagents).toBeUndefined()
    })

    it('does not clear a live AskUserQuestion card on subagent lifecycle events', () => {
      const question = claudeEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
      })
      expect(question?.payload.state).toBe('waiting')

      const spawned = claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      expect(spawned?.payload.state).toBe('waiting')
      expect(spawned?.payload.interactivePrompt).toBe(question?.payload.interactivePrompt)

      // Why: child-origin tool events must not overwrite the lead's cached
      // question card or read as the lead's own working state either.
      const childTool = claudeEvent({
        hook_event_name: 'PreToolUse',
        agent_id: 'a1',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 5' }
      })
      expect(childTool?.payload.state).toBe('waiting')
      expect(childTool?.payload.interactivePrompt).toBe(question?.payload.interactivePrompt)
      expect(childTool?.payload.toolName).toBe('AskUserQuestion')
    })

    it('keeps a child AskUserQuestion visible through its parallel sibling completion', () => {
      const question = claudeEvent({
        hook_event_name: 'PreToolUse',
        agent_id: 'a1',
        tool_use_id: 'question-1',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Pick', options: ['a', 'b'] }] }
      })

      const siblingCompletion = claudeEvent({
        hook_event_name: 'PostToolUse',
        agent_id: 'a1',
        tool_use_id: 'sibling-1',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 5' }
      })

      expect(siblingCompletion?.payload.state).toBe('waiting')
      expect(siblingCompletion?.payload.interactivePrompt).toBe(question?.payload.interactivePrompt)
      expect(siblingCompletion?.payload.toolName).toBe('AskUserQuestion')
    })

    it('preserves the interrupted flag across a gated working window', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'long job' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      const interruptedStop = claudeEvent({ hook_event_name: 'Stop', is_interrupt: true })
      // Why: the child is still running, so the pane stays working and the
      // parse layer clamps `interrupted` off this intermediate emit.
      expect(interruptedStop?.payload.state).toBe('working')
      expect(interruptedStop?.payload.interrupted).toBeUndefined()

      const drained = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(drained?.payload.state).toBe('done')
      // Why: the user's cancellation must survive to the terminal done so the
      // row reads "Interrupted by user" instead of a normal completion.
      expect(drained?.payload.interrupted).toBe(true)
    })

    it('releases a child-owned wait when the blocked child stops without another tool event', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'guarded task' })
      const blocked = claudeEvent({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a-blocked',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' }
      })
      expect(blocked?.payload.state).toBe('waiting')

      // Why: the blocked child dying (killed, errored) must not pin the
      // permission wait on the pane forever.
      const stopped = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a-blocked' })
      expect(stopped?.payload.state).toBe('working')
    })

    it('restores a finished lead to done after a child permission wait clears', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'bg task' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
      })

      const blocked = claudeEvent({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' }
      })
      expect(blocked?.payload.state).toBe('waiting')

      const approved = claudeEvent({
        hook_event_name: 'PreToolUse',
        agent_id: 'a1',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' }
      })
      expect(approved?.payload.state).toBe('working')

      // Why: the lead already stopped before the wait; draining the child
      // must resolve to done, not pin the pane on an invented 'working'.
      const drained = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(drained?.payload.state).toBe('done')
    })

    it('resolves to done when a blocked child dies after the lead finished', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'bg task' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
      })
      claudeEvent({
        hook_event_name: 'PermissionRequest',
        agent_id: 'a1',
        tool_name: 'Bash',
        tool_input: { command: 'sleep 999' }
      })

      const stopped = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(stopped?.payload.state).toBe('done')
    })

    it('removes a snapshot-seeded child missing from a present background_tasks list', () => {
      seedClaudeSubagentRosterFromSnapshots(state, PANE_KEY, [
        { id: 'a77', state: 'working', startedAt: 1000, agentType: 'general-purpose' }
      ])
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'after restart' })
      // Why: teams sessions never send an EMPTY list — the alive teammate
      // entry must not keep a phantom pre-restart child gating the pane.
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'tlkjjs0jv', type: 'teammate', status: 'running', description: 'alive' }
        ]
      })
      expect(stop?.payload.state).toBe('done')
      expect(stop?.payload.subagents).toBeUndefined()
    })

    it('keeps a snapshot-seeded child working while background_tasks still lists it', () => {
      seedClaudeSubagentRosterFromSnapshots(state, PANE_KEY, [
        { id: 'a77', state: 'working', startedAt: 1000, agentType: 'general-purpose' }
      ])
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'after restart' })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'a77', type: 'subagent', status: 'running' }]
      })
      expect(stop?.payload.state).toBe('working')
      expect(stop?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'a77', state: 'working' })
      ])
    })

    it('keeps a live child omitted by the background task snapshot cap', () => {
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'alive-after-cap',
        agent_type: 'general-purpose'
      })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: Array.from({ length: AGENT_STATUS_MAX_SUBAGENTS + 1 }, (_, index) => ({
          id: index === AGENT_STATUS_MAX_SUBAGENTS ? 'alive-after-cap' : `a${index}`,
          type: 'subagent',
          status: 'running'
        }))
      })

      // Why: the inventory was capped before this id, so omission cannot
      // prove the lifecycle-tracked child finished or was killed.
      expect(stop?.payload.subagents).toContainEqual(
        expect.objectContaining({ id: 'alive-after-cap', state: 'working' })
      )
      expect(stop?.payload.state).toBe('working')
    })

    it('does not adopt a known child turn-boundary event as the lead state', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'general-purpose'
      })
      // Why: a CLI that stops converting child Stops to SubagentStop must not
      // retire the pane while the lead still works.
      const childStop = claudeEvent({ hook_event_name: 'Stop', agent_id: 'a1' })
      expect(childStop?.payload.state).toBe('working')
      expect(childStop?.payload.prompt).toBe('go')

      const leadStop = claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
      expect(leadStop?.payload.state).toBe('done')
    })

    it('scopes TeammateIdle to the exact teammate name for hyphen-prefix names', () => {
      // Anchor the emit to a completed lead; no-lead idle events deliberately make no status claim.
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'spawn lanes' })
      claudeEvent({ hook_event_name: 'Stop', background_tasks: [] })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'alane-hooks-6d3cb5b5',
        agent_type: 'lane-hooks'
      })
      // Why: teammate "lane" must not idle "lane-hooks"'s rows via the
      // `a<name>-` prefix — the id suffix after the name is hyphen-free hex.
      const idledOther = claudeEvent({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'lane',
        team_name: 'session-x'
      })
      expect(idledOther?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'alane-hooks-6d3cb5b5', state: 'working' })
      ])

      const idled = claudeEvent({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'lane-hooks',
        team_name: 'session-x'
      })
      // Why: the exact-name match parks the row idle (turn over, still alive).
      expect(idled?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'alane-hooks-6d3cb5b5', state: 'idle' })
      ])
    })

    it('keeps an inferred interrupt terminal across later child lifecycle events', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'cancel me' })
      claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'aprobe-1',
        agent_type: 'probe'
      })
      claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'aprobe-1' })
      markClaudeLeadTurnInterrupted(state, PANE_KEY)

      const idled = claudeEvent({
        hook_event_name: 'TeammateIdle',
        teammate_name: 'probe',
        team_name: 'session-x'
      })
      expect(idled?.payload.state).toBe('done')
      expect(idled?.payload.interrupted).toBe(true)
    })

    it('does not resurrect persisted idle child rows after a restart', () => {
      // Why: the roster tracks only working children now. A persisted idle
      // snapshot (from a build that kept idle rows) is a finished child, so
      // hydration must drop it — otherwise restart would re-pile the exact
      // squatting rows this fix removes.
      seedClaudeSubagentRosterFromSnapshots(state, PANE_KEY, [
        {
          id: 'aprobe2-6d3cb5b52120b7bf',
          state: 'idle',
          startedAt: 1000,
          agentType: 'security-reviewer'
        }
      ])
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'after restart' })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'tlkjjs0jv', type: 'teammate', status: 'running', description: 'alive teammate' }
        ]
      })
      expect(stop?.payload.state).toBe('done')
      expect(stop?.payload.subagents).toBeUndefined()
    })

    it('rebuilds a running one-shot subagent from background_tasks after restart', () => {
      // Why: fresh listener state (post-restart) has no roster; a Stop that
      // reports a running non-teammate task must resurrect the child row and
      // keep the pane working rather than declaring done.
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'resume' })
      const stop = claudeEvent({
        hook_event_name: 'Stop',
        background_tasks: [
          {
            id: 'a77',
            type: 'subagent',
            status: 'running',
            description: 'long build',
            agent_type: 'general-purpose'
          }
        ]
      })
      expect(stop?.payload.state).toBe('working')
      expect(stop?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'a77', state: 'working', description: 'long build' })
      ])
    })
  })

  describe('clearClaudeAnsweredQuestionWait', () => {
    const claudeEvent = (
      payload: Record<string, unknown>
    ): ReturnType<typeof normalizeHookPayload> =>
      normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')

    it('restores working for an answered lead question and drops the card', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'pick a color' })
      const wait = claudeEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Red or Blue?' }] }
      })
      expect(wait?.payload.state).toBe('waiting')
      expect(wait?.payload.interactivePrompt).toBeDefined()

      expect(clearClaudeAnsweredQuestionWait(state, PANE_KEY)).toEqual({ state: 'working' })

      // Why: a child-driven refresh re-emits the cached lead state; the linger
      // bug would come back if it could resurrect the dismissed question.
      const childDriven = claudeEvent({
        hook_event_name: 'SubagentStart',
        agent_id: 'a1',
        agent_type: 'probe'
      })
      expect(childDriven?.payload.state).toBe('working')
      expect(childDriven?.payload.toolName).toBeUndefined()
      expect(childDriven?.payload.interactivePrompt).toBeUndefined()
    })

    it('restores the stashed lead state for an answered child question', () => {
      claudeEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
      claudeEvent({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'probe' })
      claudeEvent({ hook_event_name: 'Stop' })
      const wait = claudeEvent({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        agent_id: 'a1',
        tool_input: { questions: [{ question: 'Continue?' }] }
      })
      expect(wait?.payload.state).toBe('waiting')

      // Why: the lead already finished; the answer resumes the child, so the
      // emitted state is gated up to working only while that child still runs.
      expect(clearClaudeAnsweredQuestionWait(state, PANE_KEY)).toEqual({
        state: 'working',
        turnCompletedAt: expect.any(Number)
      })
      expect(state.claudeLeadStateByPaneKey.get(PANE_KEY)).toEqual({
        state: 'done',
        turnCompletedAt: expect.any(Number)
      })

      const drained = claudeEvent({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(drained?.payload.state).toBe('done')
    })

    it('falls back to working when no lead record exists', () => {
      expect(clearClaudeAnsweredQuestionWait(state, PANE_KEY)).toEqual({ state: 'working' })
    })
  })
})
