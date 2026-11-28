import { expect, it } from 'vitest'
import { loadDroidProbeRuns } from '../providers/droid/droid-probe-log-replay.test-fixture'
import { createDroidHookDriver, userPrompt } from './agent-hook-listener-droid-driver.test-support'

it('keeps the recorded /new row live through the old session end and drops its late second end', () => {
  const run = loadDroidProbeRuns('droid-parent-process-hooks', { promptForFirstLead: true }).find(
    (entry) => entry.name === 'tui-0.244.0/t1-new'
  )!
  const driver = createDroidHookDriver()
  const events = run.hooks.map((hook) => driver.hook(hook.payload, hook.process))

  expect(events[2]?.hookEventName).toBe('SessionEnd')
  expect(events[2]?.agentPresence?.ended).toBeUndefined()
  expect(events[2]?.payload.state).toBe('working')
  expect(events[4]).toBeNull()
  const resumed = driver.hook(
    userPrompt('s0000002-0003-4000-8000-000000000000', 'new task'),
    run.identity
  )
  expect(resumed?.providerSession?.id).toBe('s0000002-0003-4000-8000-000000000000')
  expect(resumed?.payload.prompt).toBe('new task')
})

it('keeps the row resumable when the recorded slow start arrives after SessionEnd', () => {
  const run = loadDroidProbeRuns('droid-slow-start-hooks', { promptForFirstLead: true }).find(
    (entry) => entry.name === '0.238.0/tree-d15000-p1'
  )!
  const driver = createDroidHookDriver()
  const events = run.hooks.slice(0, 4).map((hook) => driver.hook(hook.payload, hook.process))

  expect(events[2]?.hookEventName).toBe('SessionEnd')
  expect(driver.row()?.agentPresence?.ended).toBeUndefined()
  const resumed = driver.hook(
    userPrompt('s0000002-0000-4000-8000-000000000000', 'continue the resumed session'),
    run.identity
  )
  expect(resumed?.providerSession?.id).toBe('s0000002-0000-4000-8000-000000000000')
  expect(resumed?.payload.state).toBe('working')
})
