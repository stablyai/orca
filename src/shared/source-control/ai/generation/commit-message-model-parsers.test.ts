import { describe, expect, it } from 'vitest'
import { parseAntigravityModels } from './commit-message-model-parsers'

describe('parseAntigravityModels', () => {
  it('collapses multi-effort families with thinkingLevels including xhigh and max', () => {
    const stdout = [
      '\u001b[2mID\tLabel\u001b[0m',
      'claude-opus-4-6-high\tClaude Opus 4.6 (High)',
      'claude-opus-4-6-xhigh\tClaude Opus 4.6 (Extra High)',
      'claude-opus-4-6-max\tClaude Opus 4.6 (Max)',
      'gemini-3.5-flash-low\tGemini 3.5 Flash (Low)',
      'gemini-3.5-flash\tGemini 3.5 Flash (High)',
      'gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)',
      'gpt-oss-120b-medium  GPT-OSS 120B (Medium)'
    ].join('\n')

    expect(parseAntigravityModels(stdout)).toEqual([
      {
        id: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        thinkingLevels: [
          { id: 'high', label: 'High' },
          { id: 'xhigh', label: 'Extra High' },
          { id: 'max', label: 'Max' }
        ],
        defaultThinkingLevel: 'high'
      },
      { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)' },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (High)' },
      { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])
  })

  it('keeps legacy display-name rows standalone', () => {
    const stdout = 'Gemini 3.8 Flash (High)\nClaude Sonnet (Thinking)\nNoise line\n'
    expect(parseAntigravityModels(stdout)).toEqual([
      { id: 'Gemini 3.8 Flash (High)', label: 'Gemini 3.8 Flash (High)' },
      { id: 'Claude Sonnet (Thinking)', label: 'Claude Sonnet (Thinking)' }
    ])
  })
})
