import { expect, it } from 'vitest'
import { createHookListenerState } from '../../listener-state'
import type { AntigravityLaunchResult } from './antigravity-launch-results'
import { applyAntigravityLaunchResults, trackAntigravityLaunch } from './antigravity-launch-state'
import { getOrCreateAntigravityPaneState, verifyAntigravityChild } from './antigravity-pane-state'

const failedInvoke: AntigravityLaunchResult = { tool: 'invoke_subagent', children: [] }

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

  const results = new Map<number, AntigravityLaunchResult>()
  for (let step = 10; step < 310; step++) {
    record('PreToolUse', step)
    results.set(step, failedInvoke)
  }
  applyAntigravityLaunchResults(pane, results, 1)
  expect(pane.settledLaunches.size).toBe(302)
  expect(pane.launchStepsByCall.size).toBe(303)
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
