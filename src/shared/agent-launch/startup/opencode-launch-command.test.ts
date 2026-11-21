import { expect, it } from 'vitest'
import { selectOpenCodeHookAgent } from './opencode-launch-command'

const enabled = () => true

it('installs OpenCode status for a plain shell only when an OpenCode CLI is on PATH (#43445)', () => {
  expect(selectOpenCodeHookAgent(undefined, undefined, enabled, () => false)).toBeNull()
  expect(
    selectOpenCodeHookAgent(undefined, undefined, enabled, (agent) => agent === 'opencode2')
  ).toBe('opencode2')
  expect(selectOpenCodeHookAgent(undefined, 'opencode', enabled, () => false)).toBe('opencode')
  expect(selectOpenCodeHookAgent('opencode2', undefined, enabled, () => false)).toBe('opencode2')
})
