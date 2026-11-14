import { expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { liveResumeRecordChange } from './agent-resume-record-from-status'
import { keepSavedAgentSummaries } from './saved-agent-summary'

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-a:1',
    tabId: 'tab-a',
    worktreeId: 'repo::/w',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    connectionId: null,
    origin: 'live',
    ...overrides
  }
}

it('saves a later reply of a turn whose resume state did not change', () => {
  const saved = record({ lastAssistantMessage: 'first answer' })

  expect(liveResumeRecordChange(saved, record({ lastAssistantMessage: 'second answer' }))).toEqual({
    set: { ...saved, lastAssistantMessage: 'second answer' }
  })
  expect(liveResumeRecordChange(saved, record({ lastAssistantMessage: 'first answer' }))).toBeNull()
  expect(liveResumeRecordChange(saved, record())).toBeNull()
})

it("keeps a place's last reply, title and distro through a write that lacks them, never across conversations", () => {
  const saved = record({
    lastAssistantMessage: 'MANGO',
    terminalTitle: 'MANGO single-word reply',
    wslDistro: 'Ubuntu'
  })
  const previous = { 'tab-a:1': saved }

  // A wake or status with no new reply.
  expect(keepSavedAgentSummaries(previous, { 'tab-a:1': record({ state: 'waiting' }) })).toEqual({
    'tab-a:1': record({
      state: 'waiting',
      lastAssistantMessage: 'MANGO',
      terminalTitle: 'MANGO single-word reply',
      wslDistro: 'Ubuntu'
    })
  })
  // A newer reply wins.
  expect(
    keepSavedAgentSummaries(previous, {
      'tab-a:1': record({ lastAssistantMessage: 'NEW', wslDistro: 'Ubuntu' })
    })['tab-a:1']
  ).toMatchObject({ lastAssistantMessage: 'NEW' })
  // Another conversation in the same pane inherits nothing.
  for (const other of [
    record({ providerSession: { key: 'session_id', id: 'session-2' } }),
    record({ agent: 'codex' }),
    record({ wslDistro: 'Debian' }),
    record({ wslDistro: '' }),
    record({ connectionId: 'ssh:box' })
  ]) {
    const next = { 'tab-a:1': other }
    expect(keepSavedAgentSummaries(previous, next)).toBe(next)
  }
})
