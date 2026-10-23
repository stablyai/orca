import { describe, expect, it } from 'vitest'
import { gitCredentialPromptGuardEnv } from './git-credential-prompt-env'

// Mirrors @deepseek-ai/dsh-subprocess SENSITIVE_ENV_PATTERN: a bare substring
// match that deletes any environment variable whose name contains
// KEY, PASSWORD, SECRET or TOKEN before the agent's shell tool spawns a child.
const DSH_SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i

function scrubCredentialShapedNames(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!DSH_SENSITIVE_ENV_PATTERN.test(key)) {
      scrubbed[key] = value
    }
  }
  return scrubbed
}

describe('gitCredentialPromptGuardEnv', () => {
  it('emits only scalar guards that survive credential-shaped env scrubs (#26594)', () => {
    const guardEnv = gitCredentialPromptGuardEnv({ PATH: '/usr/bin' })
    const scrubbed = scrubCredentialShapedNames(guardEnv)

    // A GIT_CONFIG_COUNT whose indexed pairs were scrubbed makes Git refuse to
    // parse its command-line config at all ("missing config key GIT_CONFIG_KEY_0"),
    // so the guard itself must not emit the indexed protocol.
    expect(Object.keys(scrubbed).filter((key) => key.startsWith('GIT_CONFIG_'))).toEqual([])

    // The scalar guards keep the fail-fast behavior: no terminal prompt, and GCM
    // 'never' also covers the credential.guiPrompt case (GCM docs: disables all
    // interactivity, GUI included).
    expect(scrubbed.GIT_TERMINAL_PROMPT).toBe('0')
    expect(scrubbed.GCM_INTERACTIVE).toBe('never')
    expect(scrubbed.GIT_ASKPASS).toBe('')
    expect(scrubbed.SSH_ASKPASS).toBe('')
  })

  it('passes caller-provided indexed config through untouched', () => {
    const callerEnv: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.proxy',
      GIT_CONFIG_VALUE_0: 'http://127.0.0.1:7890'
    }
    const guardEnv = gitCredentialPromptGuardEnv(callerEnv)

    expect(guardEnv.GIT_CONFIG_COUNT).toBe('1')
    expect(guardEnv.GIT_CONFIG_KEY_0).toBe('http.proxy')
    expect(guardEnv.GIT_CONFIG_VALUE_0).toBe('http://127.0.0.1:7890')
  })
})
