// A Codex turn ends once. Codex's own report of the end (its Interrupt hook, or the marker it
// writes to its rollout) settles the turn it names; once the turn is over, a later fact for it is
// a restatement, and a fact for any other turn is Codex working again. A Stop alone is not the
// end: a Stop hook that blocks makes Codex continue the same turn.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  codexRolloutNeedsWatch,
  observeCodexRollout
} from './agent-hook-listener/providers/codex-rollout-reader'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'

describe('the Codex main agent turn, decided by turn id', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const hook = (payload: Record<string, unknown>) => normalizeAndAccept(state, 'codex', payload)

  it('keeps a cancelled turn cancelled against a later hook for that same turn', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    // A hook the cancel overtook in delivery, then a Stop racing the Interrupt.
    for (const late of [
      { hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'Stop', turn_id: 'turn-1' }
    ]) {
      expect(hook(late)?.payload).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
    }
  })

  it('reads a hook for another turn as Codex working again, with or without a prompt', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    // A turn Codex starts on its own fires no UserPromptSubmit; its first hook names the new turn.
    const resumed = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-2', tool_name: 'Bash' })

    expect(resumed?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(resumed?.payload.interrupted).toBeFalsy()
    expect(hook({ hook_event_name: 'Stop', turn_id: 'turn-2' })?.payload.mainAgent).toEqual({
      state: 'done',
      stateStartedAt: expect.any(Number)
    })
  })

  it('reads a turn a blocking Stop hook continued as working, then cancelled on its Interrupt', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })
    // Another Stop hook blocked, so Codex continues turn-1 without a new prompt or turn id.
    const continued = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    expect(continued?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })

    expect(hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('does not clear the roster on Interrupt: the subagent it left running holds the row', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', turn_id: 'child-turn' })
    const cancelled = hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })

    expect(cancelled?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: 'agent-1', state: 'working' })]
    })
    expect(
      hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', turn_id: 'child-turn' })?.payload
    ).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})

describe("the Codex main agent turn, settled from Codex's rollout", () => {
  let state: HookListenerState
  let dir: string
  let rollout: string

  beforeEach(() => {
    state = createHookListenerState()
    dir = mkdtempSync(join(tmpdir(), 'codex-turn-rollout-'))
    rollout = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rollout, marker('task_started', 'turn-1'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // Shapes as Codex writes them: `turn_aborted` carries its `TurnAbortReason` in snake_case.
  function marker(type: string, turnId: string, reason: string | null = 'interrupted'): string {
    const payload =
      type !== 'turn_aborted' || reason === null
        ? { type, turn_id: turnId }
        : { type, turn_id: turnId, reason }
    return `${JSON.stringify({ type: 'event_msg', payload })}\n`
  }

  function childStarted(threadId: string): string {
    return `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'sub_agent_activity', agent_thread_id: threadId, kind: 'started' }
    })}\n`
  }

  const hook = (payload: Record<string, unknown>) =>
    normalizeAndAccept(state, 'codex', { transcript_path: rollout, ...payload })

  it('reads turn_aborted for the current turn as the cancel, on any event, a child one included', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    const child = normalizeAndAccept(state, 'codex', {
      hook_event_name: 'PostToolUse',
      agent_id: 'agent-1',
      transcript_path: join(dir, 'rollout-child.jsonl'),
      tool_name: 'Bash'
    })
    expect(child?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('reads task_complete for the current turn as a completed turn', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('task_complete', 'turn-1'))

    const restated = hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
    expect(restated?.payload.mainAgent).toEqual({
      state: 'done',
      stateStartedAt: expect.any(Number)
    })
  })

  // Codex's app-server reports every abort as an interrupted turn, whatever its reason.
  it.each<[string | null, string]>([
    ['replaced', 'a new task took the turn over'],
    ['review_ended', 'review mode ended'],
    ['budget_limited', 'the token budget ran out'],
    [null, 'no reason recorded']
  ])('reads an abort for %s (%s) as the same cancel an Interrupt hook reports', (reason) => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1', reason))

    expect(observeCodexRollout(state, PANE_KEY)?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it("reads the current turn's end when a later turn's start lands in the same read", () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1') + marker('task_started', 'turn-2'))

    expect(observeCodexRollout(state, PANE_KEY)?.payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })

  it('keeps a turn its rollout records complete against a later fact for it', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('task_complete', 'turn-1'))

    for (const late of [
      { hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' },
      { hook_event_name: 'Interrupt', turn_id: 'turn-1' }
    ]) {
      expect(hook(late)?.payload.mainAgent).toEqual({
        state: 'done',
        stateStartedAt: expect.any(Number)
      })
    }
  })

  it('ignores a late hook for a turn the rollout ended while the next turn runs', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('task_complete', 'turn-1') + marker('task_started', 'turn-2'))
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'more', turn_id: 'turn-2' })

    expect(hook({ hook_event_name: 'Stop', turn_id: 'turn-1' })?.payload.mainAgent).toMatchObject({
      state: 'working'
    })
  })

  it("ignores another turn's end", () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-2' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    expect(
      hook({ hook_event_name: 'PreToolUse', turn_id: 'turn-2', tool_name: 'Bash' })?.payload
        .mainAgent
    ).toMatchObject({ state: 'working' })
  })

  it('adopts the open turn for hooks that carry no turn id, and settles it from the rollout', () => {
    // SessionStart never carries turn_id, and some Codex builds omit it on every hook.
    hook({ hook_event_name: 'SessionStart', source: 'startup' })
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    expect(observeCodexRollout(state, PANE_KEY)?.payload.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
  })

  it('adopts a turn that started and ended within one read when its hooks carried no turn id', () => {
    rmSync(rollout)
    writeFileSync(rollout, '')
    hook({ hook_event_name: 'SessionStart', source: 'startup' })
    appendFileSync(rollout, marker('task_started', 'turn-1') + marker('turn_aborted', 'turn-1'))

    expect(observeCodexRollout(state, PANE_KEY)?.payload.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
  })

  it('keeps the roster and the turn through a mid-turn compaction', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' })
    const compacted = hook({ hook_event_name: 'SessionStart', source: 'compact' })
    expect(compacted?.payload).toMatchObject({
      state: 'working',
      subagents: [expect.objectContaining({ id: 'agent-1' })]
    })

    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))
    expect(observeCodexRollout(state, PANE_KEY)?.payload).toMatchObject({
      state: 'working',
      mainAgent: { state: 'done', outcome: 'cancellation' },
      subagents: [expect.objectContaining({ id: 'agent-1' })]
    })
  })

  it('keeps the turn id through a compaction whose rollout shows no open turn', () => {
    rmSync(rollout)
    writeFileSync(rollout, childStarted('019fa65f-3144-7151-9c02-cff7a28f316f'))
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    hook({ hook_event_name: 'SessionStart', source: 'compact' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))

    expect(observeCodexRollout(state, PANE_KEY)?.payload.mainAgent).toMatchObject({
      state: 'done',
      outcome: 'cancellation'
    })
  })

  it('watches while a turn is open, publishing only what changed, and stops once it ends', () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    expect(codexRolloutNeedsWatch(state, PANE_KEY)).toBe(true)
    expect(observeCodexRollout(state, PANE_KEY)).toBeUndefined()

    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))
    const observed = observeCodexRollout(state, PANE_KEY)
    // An observation restates the row: no hook name, no prompt boundary.
    expect(observed).toMatchObject({
      paneKey: PANE_KEY,
      payload: { state: 'done', prompt: 'go', mainAgent: { outcome: 'cancellation' } }
    })
    expect(observed?.hookEventName).toBeUndefined()
    expect(observed?.hasExplicitPrompt).toBeUndefined()
    seedLegacyAgentStatusForTests(state, observed!)
    expect(codexRolloutNeedsWatch(state, PANE_KEY)).toBe(false)
  })

  it("keeps watching for a subagent that starts after the main agent's turn ended", () => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go', turn_id: 'turn-1' })
    appendFileSync(rollout, marker('turn_aborted', 'turn-1'))
    hook({ hook_event_name: 'Interrupt', turn_id: 'turn-1' })
    expect(codexRolloutNeedsWatch(state, PANE_KEY)).toBe(false)

    // A subagent the cancel left running spawns its own; its rollout is what will end it.
    hook({ hook_event_name: 'SubagentStart', agent_id: '019fa65f-3144-7151-9c02-cff7a28f316f' })
    expect(codexRolloutNeedsWatch(state, PANE_KEY)).toBe(true)
  })

  it('does not watch a pane with no rollout to read', () => {
    const noRollout = createHookListenerState()
    normalizeAndAccept(noRollout, 'codex', {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'go',
      turn_id: 'turn-1'
    })
    expect(codexRolloutNeedsWatch(noRollout, PANE_KEY)).toBe(false)
  })
})
