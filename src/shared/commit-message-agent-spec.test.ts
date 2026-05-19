import { describe, expect, it } from 'vitest'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  CUSTOM_AGENT_ID,
  DEFAULT_COMMIT_MESSAGE_AGENT_ID,
  getCommitMessageAgentCapability,
  getCommitMessageAgentSpec,
  getCommitMessageModelCapability,
  getCommitMessageModel,
  isCustomAgentId,
  listCommitMessageAgentCapabilities,
  listCommitMessageAgentIds,
  parseCodexModels,
  parseCursorModels,
  parseLineModels,
  parsePiModels
} from './commit-message-agent-spec'

describe('COMMIT_MESSAGE_AGENT_SPECS', () => {
  it('exposes the installed local agents as commit-message agents', () => {
    const ids = listCommitMessageAgentIds().sort()
    expect(ids).toEqual(['amp', 'claude', 'codex', 'copilot', 'cursor', 'kimi', 'opencode', 'pi'])
  })

  it('uses the strongest available defaults for core agents', () => {
    expect(COMMIT_MESSAGE_AGENT_SPECS.claude?.defaultModelId).toBe('sonnet')
    expect(COMMIT_MESSAGE_AGENT_SPECS.codex?.defaultModelId).toBe('gpt-5.5')
    expect(COMMIT_MESSAGE_AGENT_SPECS.pi?.defaultModelId).toBe('github-copilot/gpt-5.4-mini')
  })

  it('uses the provider-qualified Kimi model id accepted by the CLI', () => {
    expect(COMMIT_MESSAGE_AGENT_SPECS.kimi?.models.map((m) => m.id)).toEqual([
      'default',
      'kimi-code/kimi-for-coding'
    ])
  })

  it('lists Copilot hosted CLI models even when account policy filters the picker', () => {
    expect(COMMIT_MESSAGE_AGENT_SPECS.copilot?.defaultModelId).toBe('gpt-5.4')
    expect(COMMIT_MESSAGE_AGENT_SPECS.copilot?.models.map((m) => m.id)).toEqual([
      'auto',
      'claude-haiku-4.5',
      'claude-sonnet-4.5',
      'claude-sonnet-4.6',
      'claude-opus-4.5',
      'claude-opus-4.6',
      'claude-opus-4.6-fast',
      'claude-opus-4.7',
      'gpt-4.1',
      'gpt-5-mini',
      'gpt-5.2',
      'gpt-5.2-codex',
      'gpt-5.3-codex',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5'
    ])
  })

  it('defaults the agent picker to Claude', () => {
    expect(DEFAULT_COMMIT_MESSAGE_AGENT_ID).toBe('claude')
  })

  it('gives every model with thinking levels a valid default', () => {
    for (const spec of Object.values(COMMIT_MESSAGE_AGENT_SPECS)) {
      if (!spec) {
        continue
      }
      for (const model of spec.models) {
        if (model.thinkingLevels) {
          expect(model.defaultThinkingLevel).toBeDefined()
          expect(model.thinkingLevels.some((l) => l.id === model.defaultThinkingLevel)).toBe(true)
        }
      }
    }
  })

  it('exposes thinking levels on the Spark variant (it accepts model_reasoning_effort)', () => {
    const spark = getCommitMessageModel('codex', 'gpt-5.3-codex-spark')
    expect(spark).toBeDefined()
    expect(spark?.thinkingLevels?.map((l) => l.id)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(spark?.defaultThinkingLevel).toBe('low')
  })

  it('omits thinking levels on Claude Haiku (non-reasoning model)', () => {
    const haiku = getCommitMessageModel('claude', 'haiku')
    expect(haiku).toBeDefined()
    expect(haiku?.thinkingLevels).toBeUndefined()
    expect(haiku?.defaultThinkingLevel).toBeUndefined()
  })

  it('identifies the custom sentinel via isCustomAgentId', () => {
    expect(isCustomAgentId(CUSTOM_AGENT_ID)).toBe(true)
    expect(isCustomAgentId('claude')).toBe(false)
    expect(isCustomAgentId('codex')).toBe(false)
    expect(isCustomAgentId(null)).toBe(false)
    expect(isCustomAgentId(undefined)).toBe(false)
  })

  it('does not list "custom" alongside preset agent ids', () => {
    expect(listCommitMessageAgentIds()).not.toContain(CUSTOM_AGENT_ID)
  })

  it('orders Codex models by version descending to match the official picker', () => {
    const ids = COMMIT_MESSAGE_AGENT_SPECS.codex?.models.map((m) => m.id)
    expect(ids).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
      'gpt-5.2'
    ])
  })

  it('exposes UI capabilities without spawn details', () => {
    const capabilities = listCommitMessageAgentCapabilities()
    expect(capabilities.map((capability) => capability.id)).toContain('opencode')
    const codex = getCommitMessageAgentCapability('codex')
    expect(codex).toMatchObject({
      id: 'codex',
      label: 'Codex',
      modelSource: 'dynamic',
      defaultModelId: 'gpt-5.5'
    })
    expect(codex).not.toHaveProperty('binary')
    expect(codex).not.toHaveProperty('buildArgs')
    expect(getCommitMessageModelCapability('codex', 'gpt-5.4-mini')?.thinkingLevels).toBeDefined()
  })
})

describe('buildArgs (Claude)', () => {
  const spec = getCommitMessageAgentSpec('claude')!

  it('passes -p, output format, and model on every call', () => {
    const args = spec.buildArgs({ prompt: '', model: 'haiku' })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--model',
      'haiku',
      '--permission-mode',
      'plan'
    ])
  })

  it('appends --effort when a thinking level is supplied', () => {
    const args = spec.buildArgs({
      prompt: '',
      model: 'sonnet',
      thinkingLevel: 'high'
    })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--model',
      'sonnet',
      '--permission-mode',
      'plan',
      '--effort',
      'high'
    ])
  })

  it('omits --effort when thinkingLevel is not provided', () => {
    const args = spec.buildArgs({ prompt: '', model: 'opus' })
    expect(args).not.toContain('--effort')
  })
})

describe('model discovery parsers', () => {
  it('parses Codex model JSON', () => {
    expect(
      parseCodexModels(
        JSON.stringify({
          models: [
            {
              slug: 'gpt-5.5',
              display_name: 'GPT-5.5',
              default_reasoning_level: 'low',
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }]
            }
          ]
        })
      )
    ).toEqual([
      {
        id: 'gpt-5.5',
        label: 'GPT-5.5',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' }
        ],
        defaultThinkingLevel: 'low'
      }
    ])
  })

  it('parses one-model-per-line output', () => {
    expect(parseLineModels('opencode/gpt-5.4-mini\n\nopenai/gpt-5.5\n').map((m) => m.id)).toEqual([
      'opencode/gpt-5.4-mini',
      'openai/gpt-5.5'
    ])
  })

  it('parses Pi model table output with provider-qualified ids', () => {
    const output = [
      'provider        model                   context  max-out  thinking  images',
      'github-copilot  gpt-5.4-mini            400K     128K     yes       yes',
      'github-copilot  gpt-4o                  128K     4.1K     no        yes'
    ].join('\n')

    expect(parsePiModels(output)).toEqual([
      {
        id: 'github-copilot/gpt-5.4-mini',
        label: 'Github Copilot GPT 5.4 Mini',
        thinkingLevels: [
          { id: 'off', label: 'Off' },
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      },
      {
        id: 'github-copilot/gpt-4o',
        label: 'Github Copilot GPT 4O'
      }
    ])
  })

  it('parses Cursor model output', () => {
    expect(parseCursorModels('auto - Auto\ngpt-5.2 - GPT-5.2\n')).toEqual([
      { id: 'auto', label: 'Auto' },
      {
        id: 'gpt-5.2',
        label: 'GPT-5.2',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' }
        ],
        defaultThinkingLevel: 'low'
      }
    ])
  })
})

describe('buildArgs (Codex)', () => {
  const spec = getCommitMessageAgentSpec('codex')!

  it('runs `codex exec` without passing the prompt via argv', () => {
    const args = spec.buildArgs({
      prompt: 'PROMPT',
      model: 'gpt-5.4-mini'
    })
    expect(args[0]).toBe('exec')
    expect(args).toEqual([
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      'gpt-5.4-mini'
    ])
    expect(args).toContain('--model')
    expect(args).not.toContain('PROMPT')
    expect(spec.promptDelivery).toBe('stdin')
  })

  it('emits -c model_reasoning_effort=<level> when thinking level is supplied', () => {
    const args = spec.buildArgs({
      prompt: 'PROMPT',
      model: 'gpt-5.4',
      thinkingLevel: 'medium'
    })
    expect(args).toContain('-c')
    expect(args).toContain('model_reasoning_effort=medium')
  })

  it('omits the -c flag when no thinking level is supplied', () => {
    const args = spec.buildArgs({ prompt: 'PROMPT', model: 'gpt-5.4-mini' })
    expect(args).not.toContain('-c')
  })
})
