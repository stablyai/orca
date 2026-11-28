import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadDroidProbeRuns } from '../providers/droid/droid-probe-log-replay.test-fixture'
import {
  CHILD_ID,
  LEAD_ID,
  createDroidHookDriver,
  preTool,
  sessionStart,
  stop,
  userPrompt
} from './agent-hook-listener-droid-driver.test-support'

it('keeps the recorded Task child out of the lead prompt, tool and resume target', () => {
  const run = loadDroidProbeRuns('droid-subagent-hooks').find(
    (entry) => entry.name === 'tui-0.238.0/p1-task'
  )!
  const driver = createDroidHookDriver()
  const events = run.hooks.map((hook) => driver.hook(hook.payload, hook.process))

  expect(events[5]?.payload).toMatchObject({
    state: 'working',
    prompt: 'replayed prompt',
    toolName: 'Task',
    subagents: [{ id: 's0000002-0000-4000-8000-000000000000', state: 'working' }]
  })
  expect(events[5]?.hasExplicitPrompt).toBeUndefined()
  expect(events[5]?.providerSession?.id).toBe('s0000001-0000-4000-8000-000000000000')
  expect(events[6]?.payload.state).toBe('working')
  expect(events[6]?.payload.subagents).toBeUndefined()
  expect(driver.row()?.payload.state).toBe('done')
})

it('holds the recorded background child through the lead Stop and the child Stop until the lead wakes', () => {
  const run = loadDroidProbeRuns('droid-subagent-hooks').find(
    (entry) => entry.name === 'tui-0.238.0/p3-bg'
  )!
  const driver = createDroidHookDriver()
  const events = run.hooks.map((hook) => driver.hook(hook.payload, hook.process))

  expect(events[6]?.payload).toMatchObject({
    state: 'working',
    mainAgent: { state: 'done' },
    subagents: [{ id: 's0000002-0002-4000-8000-000000000000', state: 'working' }]
  })
  expect(events[9]?.payload).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
  expect(events[9]?.payload.subagents).toBeUndefined()
  expect(events[11]?.payload.state).toBe('working')
  expect(events[12]?.payload.state).toBe('done')
})

it('shows a child asking the user as waiting and keeps the lead Stop reply', () => {
  const driver = createDroidHookDriver()
  driver.hook(sessionStart(LEAD_ID))
  driver.hook(userPrompt(LEAD_ID))
  driver.hook(sessionStart(CHILD_ID, { calling_session_id: LEAD_ID }))

  expect(driver.hook(preTool(CHILD_ID, 'AskUser'))?.payload).toMatchObject({
    state: 'waiting',
    subagents: [{ id: CHILD_ID, state: 'waiting' }]
  })
  driver.hook(stop(CHILD_ID))
  expect(
    driver.hook({ ...stop(LEAD_ID), last_assistant_message: 'All done.' })?.replyCandidate
  ).toBe('All done.')
})

it('keeps a resumed mission worker with only a transcript caller out of the pane resume target', () => {
  const dir = mkdtempSync(join(tmpdir(), 'droid-mission-origin-'))
  try {
    const transcript = join(dir, 'worker.jsonl')
    writeFileSync(transcript, `${JSON.stringify({ callingSessionId: LEAD_ID })}\n`)
    const driver = createDroidHookDriver()
    driver.hook({ ...userPrompt(CHILD_ID, 'worker task'), transcript_path: transcript })
    driver.hook(sessionStart(CHILD_ID, { source: 'resume', transcript_path: transcript }))
    const lead = driver.hook(userPrompt(LEAD_ID, 'continue the mission'))
    const child = driver.hook({ ...preTool(CHILD_ID), transcript_path: transcript })

    expect(lead?.payload.prompt).toBe('continue the mission')
    expect(child?.payload.prompt).toBe('continue the mission')
    expect(child?.providerSession?.id).toBe('a1a1a1a1-0000-4000-8000-000000000001')
    expect(child?.hasExplicitPrompt).toBeUndefined()
    expect(driver.row()?.providerSession?.id).toBe('a1a1a1a1-0000-4000-8000-000000000001')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
