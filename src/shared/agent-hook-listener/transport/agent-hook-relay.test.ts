import { expect, it } from 'vitest'
import { createShedSubagentsField, restoreShedStatusFields } from './agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../agent-status/contracts/agent-status-types'

function status(toolName: string, toolInput: string) {
  const payload = normalizeAgentStatusPayload({
    state: 'working',
    prompt: 'job',
    agentType: 'antigravity',
    subagents: [{ id: 'w1', state: 'working', startedAt: 1, toolName, toolInput }]
  })
  if (!payload?.subagents) {
    throw new Error('status fixture did not normalize')
  }
  return { ...payload, subagents: payload.subagents }
}

it('restores no shed roster whose worker has since changed tools', () => {
  const previous = status('read_file', 'old.ts')
  const next = status('run_command', 'new-command')
  const shed = { ...next, subagents: undefined }

  expect(
    restoreShedStatusFields(shed, [createShedSubagentsField(next.subagents)], previous).subagents
  ).toBeUndefined()
  expect(
    restoreShedStatusFields(shed, [createShedSubagentsField(previous.subagents)], previous)
      .subagents
  ).toEqual(previous.subagents)
})
