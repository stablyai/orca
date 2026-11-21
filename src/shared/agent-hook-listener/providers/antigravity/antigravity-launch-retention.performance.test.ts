import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import { normalizeAntigravityEvent } from './antigravity-events'
import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { applyAntigravityLaunchResults } from './antigravity-launch-state'
import { getOrCreateAntigravityPaneState, verifyAntigravityChild } from './antigravity-pane-state'

const failedInvoke: AntigravityLaunchResult = { tool: 'invoke_subagent', children: [] }

function rootLaunchFixture() {
  const state = createHookListenerState()
  const pane = getOrCreateAntigravityPaneState(state, 'pane')
  const hook = (
    phase: 'PreToolUse' | 'PostToolUse',
    step: number,
    callId = `invoke-${step}`,
    name = 'invoke_subagent',
    args = {}
  ) =>
    normalizeAntigravityEvent(
      state,
      phase,
      'Task',
      'pane',
      { conversationId: 'root', stepIdx: step, toolCall: { id: callId, name, args } },
      'root'
    )
  return { pane, hook }
}

// PR #45054: a long-lived root must release completed identities even when a hook phase is lost.
it.each([10_000, 100_000])('retains no launch identities after %s settled hook pairs', (count) => {
  const { pane, hook } = rootLaunchFixture()
  const results = new Map<number, AntigravityLaunchResult>()
  for (let step = 0; step < count; step++) {
    const first = step % 2 === 0 ? 'PreToolUse' : 'PostToolUse'
    const second = first === 'PreToolUse' ? 'PostToolUse' : 'PreToolUse'
    hook(first, step)
    if (step % 3 === 0) {
      hook(second, step)
    }
    results.set(step, failedInvoke)
    applyAntigravityLaunchResults(pane, results, 1)
    results.delete(step)
    if (step % 3 !== 0) {
      hook(second, step)
    }
  }
  expect(pane.pendingLaunches.size).toBe(0)
  expect(pane.settledLaunches.size).toBe(0)
  expect(pane.launchStepsByCall.size).toBe(0)
  expect(pane.currentLaunch).toBeUndefined()
})

it.each([1_000, 10_000])(
  'bounds completed launch history after %s missing phases and their late delivery',
  (count) => {
    const { pane, hook } = rootLaunchFixture()
    const results = new Map<number, AntigravityLaunchResult>()
    for (let step = 0; step < count; step++) {
      const first = step % 2 === 0 ? 'PreToolUse' : 'PostToolUse'
      hook(first, step)
      results.set(step, failedInvoke)
      applyAntigravityLaunchResults(pane, results, 1)
      results.delete(step)
    }
    hook('PreToolUse', count, 'active')
    expect(pane.settledLaunches.size).toBe(256)
    expect(pane.launchStepsByCall.size).toBe(257)
    expect(pane.settledLaunches.keys().next().value).toBe(count - 256)
    expect(pane.launchStepsByCall.has(`invoke-${count - 257}`)).toBe(false)

    for (let repeat = 0; repeat < 2; repeat++) {
      for (let step = 0; step < count - 256; step++) {
        const late = step % 2 === 0 ? 'PostToolUse' : 'PreToolUse'
        hook(late, step)
      }
    }
    for (let step = 1; step < count - 256; step++) {
      hook('PostToolUse', 0, `conflict-${step}`)
    }
    expect([...pane.pendingLaunches.keys()]).toEqual([count, 0, undefined])
    expect(pane.settledLaunches.size).toBe(256)
    expect(pane.launchStepsByCall.size).toBe(258)
    expect(pane.launchStepsByCall.get('active')).toBe(count)
    expect(pane.currentLaunch?.callId).toBe('active')
  }
)

it('retains unpaired results and keeps ambiguous launches held independently of verified children', () => {
  const { pane, hook } = rootLaunchFixture()
  const resultWithChild: AntigravityLaunchResult = {
    tool: 'invoke_subagent',
    children: ['child']
  }

  hook('PreToolUse', 1)
  hook('PreToolUse', 1)
  hook('PostToolUse', 2)
  hook('PreToolUse', 3)
  applyAntigravityLaunchResults(
    pane,
    new Map([
      [1, resultWithChild],
      [2, failedInvoke]
    ]),
    1
  )
  verifyAntigravityChild(pane, 'child')

  expect(pane.settledLaunches.size).toBe(2)
  expect(pane.launchStepsByCall.size).toBe(3)
  expect([...pane.pendingLaunches.keys()]).toEqual([3])

  expect(hook('PostToolUse', 1)).toBeNull()
  expect(pane.settledLaunches.has(1)).toBe(false)
  expect(pane.launchStepsByCall.has('invoke-1')).toBe(false)
  expect([...pane.verifiedChildren]).toEqual(['child'])

  hook('PostToolUse', 4, 'invoke-2')
  expect(hook('PreToolUse', 2)).toBeNull()
  expect(pane.settledLaunches.has(2)).toBe(false)
  expect(pane.launchStepsByCall.get('invoke-2')).toBe(2)
  hook('PostToolUse', 3, 'different-call')
  applyAntigravityLaunchResults(
    pane,
    new Map([
      [2, failedInvoke],
      [3, failedInvoke],
      [4, failedInvoke]
    ]),
    1
  )
  expect([...pane.pendingLaunches]).toEqual([
    [3, null],
    [2, null],
    [4, null]
  ])
})

it('evicts the oldest on the 257th completion without releasing parallel Swarm ownership', () => {
  const { pane, hook } = rootLaunchFixture()
  const swarm = (step: number, callId: string) =>
    hook('PreToolUse', step, callId, 'swarm', { action: 'add', tasks: ['a', 'b'] })
  swarm(1, 'swarm-1')
  swarm(2, 'swarm-2')
  swarm(3, 'swarm-2')
  applyAntigravityLaunchResults(
    pane,
    new Map<number, AntigravityLaunchResult>([
      [1, { tool: 'swarm', children: ['verified', 'expected'] }],
      [2, { tool: 'swarm', children: ['ambiguous-a', 'ambiguous-b'] }]
    ]),
    1
  )
  verifyAntigravityChild(pane, 'verified')
  swarm(4, 'swarm-1')

  for (let step = 10; step <= 266; step++) {
    hook('PreToolUse', step)
  }
  // The latest hook can produce the oldest result that still awaits its second phase.
  const results = new Map([[266, failedInvoke]])
  for (let step = 10; step < 264; step++) {
    results.set(step, failedInvoke)
  }
  applyAntigravityLaunchResults(pane, results, 1)
  expect(pane.settledLaunches.size).toBe(256)
  expect(pane.currentLaunch?.callId).toBe('invoke-266')

  // Keep a live conflicting reverse association when the settled identity at that step is evicted.
  applyAntigravityLaunchResults(pane, new Map([[264, failedInvoke]]), 1)
  expect(pane.settledLaunches.has(1)).toBe(false)
  expect(pane.launchStepsByCall.get('swarm-1')).toBe(1)
  applyAntigravityLaunchResults(pane, new Map([[265, failedInvoke]]), 1)
  expect(pane.currentLaunch).toBeUndefined()
  expect(pane.launchStepsByCall.has('invoke-266')).toBe(false)
  expect([...pane.pendingLaunches]).toEqual([
    [2, null],
    [3, null],
    [1, null],
    [4, null]
  ])
  expect([...pane.verifiedChildren]).toEqual(['verified'])
  expect([...pane.expectedChildren]).toEqual(['expected'])
})
