import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { applyAntigravityLaunchResults, trackAntigravityLaunch } from './antigravity-launch-state'
import { getOrCreateAntigravityPaneState, verifyAntigravityChild } from './antigravity-pane-state'

const failedInvoke: AntigravityLaunchResult = { tool: 'invoke_subagent', children: [] }

// PR #45054: a long-lived root must release completed identities even when a hook phase is lost.
it.each([10_000, 100_000])('retains no launch identities after %s settled hook pairs', (count) => {
  const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
  const results = new Map<number, AntigravityLaunchResult>()
  for (let step = 0; step < count; step++) {
    const callId = `invoke-${step}`
    const first = step % 2 === 0 ? 'PreToolUse' : 'PostToolUse'
    const second = first === 'PreToolUse' ? 'PostToolUse' : 'PreToolUse'
    trackAntigravityLaunch(pane, first, step, callId, 'invoke_subagent', {})
    if (step % 3 === 0) {
      trackAntigravityLaunch(pane, second, step, callId, 'invoke_subagent', {})
    }
    results.set(step, failedInvoke)
    applyAntigravityLaunchResults(pane, results, 1)
    results.delete(step)
    if (step % 3 !== 0) {
      trackAntigravityLaunch(pane, second, step, callId, 'invoke_subagent', {})
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
    const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
    const results = new Map<number, AntigravityLaunchResult>()
    trackAntigravityLaunch(pane, 'PreToolUse', count, 'active', 'invoke_subagent', {})
    for (let step = 0; step < count; step++) {
      const first = step % 2 === 0 ? 'PreToolUse' : 'PostToolUse'
      trackAntigravityLaunch(pane, first, step, `invoke-${step}`, 'invoke_subagent', {})
      results.set(step, failedInvoke)
      applyAntigravityLaunchResults(pane, results, 1)
      results.delete(step)
    }
    expect(pane.settledLaunches.size).toBe(256)
    expect(pane.launchStepsByCall.size).toBe(257)
    expect(pane.settledLaunches.keys().next().value).toBe(count - 256)
    expect(pane.launchStepsByCall.has(`invoke-${count - 257}`)).toBe(false)

    for (let repeat = 0; repeat < 2; repeat++) {
      for (let step = 0; step < count - 256; step++) {
        const late = step % 2 === 0 ? 'PostToolUse' : 'PreToolUse'
        trackAntigravityLaunch(pane, late, step, `invoke-${step}`, 'invoke_subagent', {})
      }
    }
    for (let step = 1; step < count - 256; step++) {
      trackAntigravityLaunch(pane, 'PostToolUse', 0, `conflict-${step}`, 'invoke_subagent', {})
    }
    expect([...pane.pendingLaunches.keys()]).toEqual([count, 0, undefined])
    expect(pane.settledLaunches.size).toBe(256)
    expect(pane.launchStepsByCall.size).toBe(258)
    expect(pane.launchStepsByCall.get('active')).toBe(count)
    expect(pane.currentLaunch?.callId).toBe(`invoke-${count - 1}`)
  }
)

it('retains unpaired results and keeps ambiguous launches held independently of verified children', () => {
  const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
  pane.rootConversationId = 'root'
  const record = (phase: 'PreToolUse' | 'PostToolUse', step: number, callId = `invoke-${step}`) =>
    trackAntigravityLaunch(pane, phase, step, callId, 'invoke_subagent', {})
  const resultWithChild: AntigravityLaunchResult = {
    tool: 'invoke_subagent',
    children: ['child']
  }

  record('PreToolUse', 1)
  record('PreToolUse', 1)
  record('PostToolUse', 2)
  record('PreToolUse', 3)
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

  expect(record('PostToolUse', 1)).toBe('stale')
  expect(pane.settledLaunches.has(1)).toBe(false)
  expect(pane.launchStepsByCall.has('invoke-1')).toBe(false)
  expect([...pane.verifiedChildren]).toEqual(['child'])

  record('PostToolUse', 4, 'invoke-2')
  expect(record('PreToolUse', 2)).toBe('stale')
  expect(pane.settledLaunches.has(2)).toBe(false)
  expect(pane.launchStepsByCall.get('invoke-2')).toBe(2)
  record('PostToolUse', 3, 'different-call')
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
  const pane = getOrCreateAntigravityPaneState(createHookListenerState(), 'pane')
  const swarm = (step: number, callId: string) =>
    trackAntigravityLaunch(pane, 'PreToolUse', step, callId, 'swarm', { tasks: ['a', 'b'] })
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
    trackAntigravityLaunch(pane, 'PreToolUse', step, `invoke-${step}`, 'invoke_subagent', {})
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
