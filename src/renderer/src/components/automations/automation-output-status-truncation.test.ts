import { describe, expect, it } from 'vitest'
import {
  normalizeAgentStatusPayload,
  pickParsedAgentStatusPayload
} from '../../../../shared/agent-status/contracts/agent-status-types'
import { selectAutomationRunOutputSnapshot } from './automation-run-output-snapshot'

describe('automation output from bounded agent status', () => {
  it.each([
    { name: 'over the wire cap', text: 'a'.repeat(8001), length: 8000, truncated: true },
    { name: 'exactly the cap', text: 'a'.repeat(8000), length: 8000, truncated: false },
    {
      name: 'a cut supplementary character',
      text: `${'a'.repeat(7999)}😀`,
      length: 7999,
      truncated: true
    },
    { name: 'collapsed newlines', text: `a${'\n'.repeat(8000)}b`, length: 4, truncated: false }
  ])('retains completion integrity for $name', ({ text, length, truncated }) => {
    const host = normalizeAgentStatusPayload({ state: 'done', lastAssistantMessage: text })!
    const client = normalizeAgentStatusPayload(pickParsedAgentStatusPayload(host))!
    const snapshot = selectAutomationRunOutputSnapshot(
      client.lastAssistantMessage,
      null,
      client.lastAssistantMessageTruncated
    )!
    expect(snapshot.content).toHaveLength(length)
    expect(snapshot.truncated).toBe(truncated)
  })
})
