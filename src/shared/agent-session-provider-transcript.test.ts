import { expect, it } from 'vitest'
import { isPersistedAgentSessionRecord } from './agent-session-record'
import { agentSessionRecordFixture } from './agent-session-record.test-fixture'

it('accepts old records and optional host-local transcript metadata while rejecting malformed paths', () => {
  const record = agentSessionRecordFixture()
  expect(isPersistedAgentSessionRecord(record)).toBe(true)
  for (const path of [
    '/provider/root.jsonl',
    'C:\\provider\\root.jsonl',
    '\\\\host\\share\\root.jsonl'
  ]) {
    expect(
      isPersistedAgentSessionRecord({ ...record, providerTranscript: { path, handleRoot: 'root' } })
    ).toBe(true)
  }
  for (const path of ['', '../other.jsonl', '/bad\0path', `/${'a'.repeat(4096)}`]) {
    expect(
      isPersistedAgentSessionRecord({ ...record, providerTranscript: { path, handleRoot: 'root' } })
    ).toBe(false)
  }
  expect(
    isPersistedAgentSessionRecord({
      ...record,
      providerTranscript: { path: '/root', handleRoot: '' }
    })
  ).toBe(false)
})
