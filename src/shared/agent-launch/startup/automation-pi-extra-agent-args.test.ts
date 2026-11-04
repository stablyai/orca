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

  it('refuse a model override that could move an unpinned Command key to another provider', () => {
    for (const command of [
      'pi --api-key key',
      'pi --name --provider --api-key key',
      'echo --provider openai && pi --api-key key',
      `sh -c 'exec pi --api-key key "$@"' sh`
    ]) {
      expect(() => pi('--model anthropic/claude', { agentCmdOverrides: { pi: command } })).toThrow(
        /--provider beside/
      )
    }
  })

  it('refuse a model override when the provider beside an inline key is empty or missing', () => {
    for (const args of [
      "--provider '' --api-key key",
      "--provider openai --provider '' --api-key key"
    ]) {
      expect(() => pi('--model anthropic/claude', { agentDefaultArgs: { pi: args } })).toThrow(
        /--provider beside/
      )
    }
  })

  it('keep dash-leading operands of default options', () => {
    expect(
      pi('--model new', { agentDefaultArgs: { pi: '--system-prompt --model --model old' } })
    ).toEqual(['pi', '--system-prompt', '--model', '--model', 'new'])
    // Pi reads `--api-key` here as the model, so removing the default must not expose it as a key.
    expect(pi('--model new', { agentDefaultArgs: { pi: '--model --api-key key' } })).toEqual([
      'pi',
      'key',
      '--model',
      'new'
    ])
  })
})
