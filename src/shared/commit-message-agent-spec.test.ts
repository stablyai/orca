import { describe, expect, it } from 'vitest'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  DEFAULT_COMMIT_MESSAGE_AGENT_ID,
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  listCommitMessageAgentIds
} from './commit-message-agent-spec'

describe('COMMIT_MESSAGE_AGENT_SPECS', () => {
  it('exposes Claude and Codex as the v1 agents', () => {
    const ids = listCommitMessageAgentIds().sort()
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('uses the smallest model as the default for each agent', () => {
    expect(COMMIT_MESSAGE_AGENT_SPECS.claude?.defaultModelId).toBe('claude-haiku-4-5')
    expect(COMMIT_MESSAGE_AGENT_SPECS.codex?.defaultModelId).toBe('gpt-5.4-mini')
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

  it('keeps the spark variant without thinking levels', () => {
    const spark = getCommitMessageModel('codex', 'gpt-5.3-codex-spark')
    expect(spark).toBeDefined()
    expect(spark?.thinkingLevels).toBeUndefined()
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

  it('runs `codex exec` and passes the prompt as the trailing argv arg', () => {
    const args = spec.buildArgs({
      prompt: 'PROMPT',
      model: 'gpt-5.4-mini'
    })
    expect(args[0]).toBe('exec')
    expect(args).toContain('--model')
    expect(args.at(-1)).toBe('PROMPT')
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
