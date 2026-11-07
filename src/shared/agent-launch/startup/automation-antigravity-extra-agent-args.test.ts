import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

function agy(extraAgentArgs: string, defaults: string): string[] {
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'antigravity',
      settings: { agentDefaultArgs: { antigravity: defaults } },
      extraAgentArgs,
      platform: 'linux',
      isRemote: false,
      shell: 'posix'
    }),
    prompt: 'go'
  })
  const parsed = tokenizeStartupCommand(plan?.launchCommand ?? '', 'posix')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.tokens
}

describe('Antigravity automation extras', () => {
  it('replace the default model and effort and keep other defaults', () => {
    expect(
      agy(
        '--model gemini-4-argon --effort=high',
        '--dangerously-skip-permissions --model=old --effort low'
      )
    ).toEqual([
      'agy',
      '--dangerously-skip-permissions',
      '--model',
      'gemini-4-argon',
      '--effort=high',
      '--prompt-interactive',
      'go'
    ])
  })

  it('refuse permission and mode flags', () => {
    expect(() => agy('--dangerously-skip-permissions', '')).toThrow(
      '"--dangerously-skip-permissions" isn\'t allowed'
    )
    expect(() => agy('--mode auto', '')).toThrow('"--mode" isn\'t allowed')
  })
})
