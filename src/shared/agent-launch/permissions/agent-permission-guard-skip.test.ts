import { expect, it } from 'vitest'
import type { AgentPermissionChoice } from './tui-agent-permission-choice'
import { permissionGuardSkipInUse } from './agent-permission-guard-skip'

const settings = (agent: string, choice: AgentPermissionChoice, value: string) => ({
  agentPermissionDefault: choice,
  agentDefaultEnv: { [agent]: { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: value } }
})

it.each([
  ['claude', 'full-access', '1', true],
  ['claude-agent-teams', 'full-access', 'true', true],
  ['claude', 'ask', '1', false],
  ['claude', 'full-access', '0', false],
  ['codex', 'full-access', '1', false]
] as const)('%s on %s with the variable set to %s: %s', (agent, choice, value, inUse) => {
  expect(permissionGuardSkipInUse(settings(agent, choice, value))).toBe(inUse)
})
