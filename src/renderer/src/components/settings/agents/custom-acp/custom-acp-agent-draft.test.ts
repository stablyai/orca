import { expect, it } from 'vitest'
import { CUSTOM_ACP_AGENT_LIMITS } from '../../../../../../shared/agent-launch/custom-acp/custom-acp-agent'
import {
  customAcpAgentDraftProblems,
  emptyCustomAcpAgentDraft,
  saveCustomAcpAgentDraft,
  type CustomAcpAgentDraft
} from './custom-acp-agent-draft'

const draft = (args: string[], env: Record<string, string> = {}): CustomAcpAgentDraft => ({
  ...emptyCustomAcpAgentDraft(),
  name: 'Mine',
  command: 'mine',
  args: args.map((value, key) => ({ key, value })),
  env: Object.entries(env).map(([name, value], key) => ({ key, name, value }))
})

it('holds Save while a value is too long for saved settings to keep', () => {
  expect(customAcpAgentDraftProblems(draft(['acp'])).has('tooLong')).toBe(false)
  const longArg = 'x'.repeat(CUSTOM_ACP_AGENT_LIMITS.arg + 1)
  expect(customAcpAgentDraftProblems(draft([longArg])).has('tooLong')).toBe(true)
  const longValue = 'x'.repeat(CUSTOM_ACP_AGENT_LIMITS.envValue + 1)
  expect(customAcpAgentDraftProblems(draft([], { MINE: longValue })).has('tooLong')).toBe(true)
})

it('saves an empty argument as written', () => {
  const [saved] = saveCustomAcpAgentDraft([], draft(['--prefix', '', 'input.txt']), () => 'abc')
  expect(saved.args).toEqual(['--prefix', '', 'input.txt'])
})
