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
  listCommitMessageAgentIds
} from './commit-message-agent-spec'

describe('COMMIT_MESSAGE_AGENT_SPECS', () => {
  it('exposes Claude and Codex as the v1 agents', () => {
    const ids = listCommitMessageAgentIds().sort()
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('uses the smartest model as the default for each agent', () => {
    expect(COMMIT_MESSAGE_AGENT_SPECS.claude?.defaultModelId).toBe('claude-opus-4-7')
    expect(COMMIT_MESSAGE_AGENT_SPECS.codex?.defaultModelId).toBe('gpt-5.5')
  })

  it('defaults the agent picker to Claude', () => {
    expect(DEFAULT_COMMIT_MESSAGE_AGENT_ID).toBe('claude')
  })

  it('defaults every model with thinking levels to "low"', () => {
    for (const spec of Object.values(COMMIT_MESSAGE_AGENT_SPECS)) {
      if (!spec) {
        continue
      }
      for (const model of spec.models) {
        if (model.thinkingLevels) {
          expect(model.defaultThinkingLevel).toBe('low')
          expect(model.thinkingLevels.some((l) => l.id === 'low')).toBe(true)
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

  it('omits thinking levels on Claude Haiku 4.5 (non-reasoning model)', () => {
    const haiku = getCommitMessageModel('claude', 'claude-haiku-4-5')
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
    expect(capabilities.map((capability) => capability.id).sort()).toEqual(['claude', 'codex'])
    const codex = getCommitMessageAgentCapability('codex')
    expect(codex).toMatchObject({
      id: 'codex',
      label: 'Codex',
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
    const args = spec.buildArgs({ prompt: '', model: 'claude-haiku-4-5' })
    expect(args).toEqual(['-p', '--output-format', 'text', '--model', 'claude-haiku-4-5'])
  })

  it('appends --effort when a thinking level is supplied', () => {
    const args = spec.buildArgs({
      prompt: '',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'high'
    })
    expect(args).toEqual([
      '-p',
      '--output-format',
      'text',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'high'
    ])
  })

  it('omits --effort when thinkingLevel is not provided', () => {
    const args = spec.buildArgs({ prompt: '', model: 'claude-opus-4-7' })
    expect(args).not.toContain('--effort')
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
