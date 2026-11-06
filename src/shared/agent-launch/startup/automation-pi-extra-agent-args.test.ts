import { describe, expect, it } from 'vitest'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

function pi(extraAgentArgs: string, settings: AgentStartupSettings): string[] {
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'pi',
      settings,
      extraAgentArgs,
      platform: 'linux',
      isRemote: false,
      shell: 'posix'
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  const parsed = tokenizeStartupCommand(plan?.launchCommand ?? '', 'posix')
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.tokens
}

describe('Pi automation extras', () => {
  it('replace the model and thinking within the pinned provider, keeping its key', () => {
    const defaults = { pi: '--provider openrouter --api-key key --model old --thinking low' }
    expect(pi('--model=anthropic/claude --thinking high', { agentDefaultArgs: defaults })).toEqual([
      'pi',
      '--provider',
      'openrouter',
      '--api-key',
      'key',
      '--model',
      'anthropic/claude',
      '--thinking',
      'high'
    ])
    expect(() => pi('--thinking extreme', { agentDefaultArgs: defaults })).toThrow(
      /--thinking accepts off/
    )
  })

  it('keep dash-leading operands of default options', () => {
    expect(
      pi('--model new', { agentDefaultArgs: { pi: '--system-prompt --model --model old' } })
    ).toEqual(['pi', '--system-prompt', '--model', '--model', 'new'])
    // Pi reads `--api-key` here as the model's value, so it goes with the removed default.
    expect(pi('--model new', { agentDefaultArgs: { pi: '--model --api-key key' } })).toEqual([
      'pi',
      'key',
      '--model',
      'new'
    ])
  })
})
