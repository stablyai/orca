import { describe, expect, it } from 'vitest'
import { CreateAgentSessionParams } from '../rpc-contract/agent-session-params'
import { withAgentKeyLaunchEnv } from './agent-key-launch-env'

const base = {
  clientOperationId: `${Date.now()}-${'a'.repeat(32)}`,
  worktree: 'id:w',
  agent: 'claude'
}

describe('keyEnv on a host-built launch', () => {
  it('accepts API keys and refuses subscription tokens or launch-steering names', () => {
    expect(
      CreateAgentSessionParams.safeParse({
        ...base,
        keyEnv: { ANTHROPIC_API_KEY: 'sk-ant-api03-ok' }
      }).success
    ).toBe(true)
    for (const keyEnv of [
      { ANTHROPIC_API_KEY: 'sk-ant-oat01-subscription' },
      { CLAUDE_CODE_OAUTH_TOKEN: 'x' },
      { LD_PRELOAD: '/tmp/x.so' },
      { PATH: '/tmp' }
    ]) {
      const parsed = CreateAgentSessionParams.safeParse({ ...base, keyEnv })
      expect(parsed.success).toBe(false)
      // Refusals are logged; the value must not ride the issue text.
      expect(JSON.stringify(parsed.error?.issues)).not.toContain(Object.values(keyEnv)[0])
    }
  })

  it('folds under account routing so routing still wins', () => {
    expect(
      withAgentKeyLaunchEnv({ CLAUDE_CONFIG_DIR: '/h/.claude' }, { ANTHROPIC_API_KEY: 'k' })
    ).toEqual({ ANTHROPIC_API_KEY: 'k', CLAUDE_CONFIG_DIR: '/h/.claude' })
    expect(withAgentKeyLaunchEnv(undefined, undefined)).toBeUndefined()
  })
})
