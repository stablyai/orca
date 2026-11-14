import { describe, expect, it } from 'vitest'
import {
  parseAntigravityAcpModels,
  parseAntigravityCommitModels
} from './antigravity-models-parser'
import { parseAntigravityModels } from './source-control/ai/generation/commit-message-model-parsers'

const AGY_1_5_8_MODELS_STDOUT = [
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-pro-orchestrator-argon\tOrchestrator (Argon)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n')

describe('antigravity models parser', () => {
  it('collapses agy 1.5.8 effort families while keeping single-variant and effortless models standalone', () => {
    const models = parseAntigravityAcpModels(AGY_1_5_8_MODELS_STDOUT)
    expect(models.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'gemini-4-carbon', label: 'Gemini 4 Carbon' },
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon' },
      { id: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
      { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)' },
      { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)' },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
    ])

    expect(models.find((m) => m.id === 'gemini-4-hydrogen')?.efforts).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' }
    ])
    expect(models.find((m) => m.id === 'gemini-4-carbon')?.efforts).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ])
    expect(models.find((m) => m.id === 'claude-opus-5-5')?.efforts).toEqual([
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ])
    expect(models.find((m) => m.id === 'gemini-pro-orchestrator')?.efforts).toEqual([])
    expect(models.find((m) => m.id === 'gemini-pro-orchestrator-argon')?.efforts).toEqual([])
    expect(models.find((m) => m.id === 'gpt-oss-120b-medium')?.efforts).toEqual([])
    expect(models.every((m) => m.effortsKnown !== false)).toBe(true)
    expect(models.every((m) => m.isDefault === false && m.defaultEffort === undefined)).toBe(true)
  })

  it('parses TTY space-padded columns, ANSI/spinner noise, out-of-order variants, and max effort', () => {
    const ttyOutput = [
      '\u001b[2K\r⠋ Fetching available models...',
      'ID                     NAME',
      'gemini-4-ultra-max     Gemini 4 Ultra (Max)',
      'gemini-4-ultra-low     Gemini 4 Ultra (Low)',
      'gemini-4-ultra-xhigh   Gemini 4 Ultra (Extra High)',
      'gemini-4-ultra-high    Gemini 4 Ultra (High)',
      'gemini-4-ultra-medium  Gemini 4 Ultra (Medium)',
      'gemini-pro-orchestrator   Orchestrator (Carbon)'
    ].join('\r\n')

    const acp = parseAntigravityAcpModels(ttyOutput)
    expect(acp).toEqual([
      {
        id: 'gemini-4-ultra',
        label: 'Gemini 4 Ultra',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'xhigh', label: 'Extra high' },
          { value: 'max', label: 'Max' }
        ]
      },
      {
        id: 'gemini-pro-orchestrator',
        label: 'Orchestrator (Carbon)',
        isDefault: false,
        efforts: []
      }
    ])
  })

  it('produces CommitMessageModel entries with Extra High / Max thinkingLevels only on multi-variant families', () => {
    const commitModels = parseAntigravityModels(
      `${AGY_1_5_8_MODELS_STDOUT}\ngemini-4-hydrogen-max\tGemini 4 Hydrogen (Max)`
    )
    expect(commitModels).toEqual(
      parseAntigravityCommitModels(
        `${AGY_1_5_8_MODELS_STDOUT}\ngemini-4-hydrogen-max\tGemini 4 Hydrogen (Max)`
      )
    )

    const hydrogen = commitModels.find((m) => m.id === 'gemini-4-hydrogen')
    expect(hydrogen).toEqual({
      id: 'gemini-4-hydrogen',
      label: 'Gemini 4 Hydrogen',
      thinkingLevels: [
        { id: 'low', label: 'Low' },
        { id: 'medium', label: 'Medium' },
        { id: 'high', label: 'High' },
        { id: 'xhigh', label: 'Extra High' },
        { id: 'max', label: 'Max' }
      ],
      defaultThinkingLevel: 'low'
    })

    const orchestrator = commitModels.find((m) => m.id === 'gemini-pro-orchestrator')
    expect(orchestrator).toEqual({
      id: 'gemini-pro-orchestrator',
      label: 'Orchestrator (Carbon)'
    })

    const gptOss = commitModels.find((m) => m.id === 'gpt-oss-120b-medium')
    expect(gptOss).toEqual({
      id: 'gpt-oss-120b-medium',
      label: 'GPT-OSS 120B (Medium)'
    })
  })

  it('keeps legacy display-name rows standalone', () => {
    const legacy = ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (thinking)', 'garbage line'].join(
      '\n'
    )
    expect(parseAntigravityAcpModels(legacy)).toEqual([
      {
        id: 'Gemini 3.8 Flash (High)',
        label: 'Gemini 3.8 Flash (High)',
        isDefault: false,
        efforts: []
      },
      {
        id: 'Gemini 3.8 Flash (thinking)',
        label: 'Gemini 3.8 Flash (thinking)',
        isDefault: false,
        efforts: []
      }
    ])
  })
})
