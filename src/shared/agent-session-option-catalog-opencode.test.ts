import { describe, expect, it } from 'vitest'
import {
  getAgentSessionOptionCatalog,
  mergeDiscoveredAuthoritativeModels
} from './agent-session-option-catalog'
import { OPENCODE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-opencode'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

describe('opencode session option catalog', () => {
  it('is registered for the opencode agent', () => {
    expect(getAgentSessionOptionCatalog('opencode')).toBe(OPENCODE_SESSION_OPTION_CATALOG)
  })

  it('seeds the verified gateway models, mirroring the commit-message registry', () => {
    expect(
      OPENCODE_SESSION_OPTION_CATALOG.models.map(({ id, isDefault }) => ({ id, isDefault }))
    ).toEqual([
      { id: 'opencode/deepseek-v4-flash-free', isDefault: true },
      { id: 'opencode/gpt-5.4-mini', isDefault: undefined }
    ])
  })

  it('emits the verified -m flag for a picked model', () => {
    // Verified CLI surface: `opencode --help` documents `-m, --model  model to
    // use in the format of provider/model`.
    expect(OPENCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs!('opencode/gpt-5.4-mini')).toEqual(
      ['-m', 'opencode/gpt-5.4-mini']
    )
    expect(resolveAgentSessionOptionLaunch('opencode', { model: 'opencode/gpt-5.4-mini' })).toEqual(
      {
        args: ['-m', 'opencode/gpt-5.4-mini'],
        appliedValues: { model: 'opencode/gpt-5.4-mini' }
      }
    )
  })

  it('spawns vanilla when no model was ever picked', () => {
    expect(resolveAgentSessionOptionLaunch('opencode', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })

  it('delegates mid-session model changes to the CLI picker like codex', () => {
    // OpenCode has no argument-taking /model command — /models opens the CLI's
    // own interactive picker, so orca must type the command rather than assert
    // a value it cannot apply on OpenCode's behalf.
    const midSession = OPENCODE_SESSION_OPTION_CATALOG.modelApply.midSession
    expect(midSession).toEqual({ kind: 'agent-picker', command: '/models', delivery: 'type' })
  })

  it('detects a user-supplied model flag in every spelling', () => {
    const modelOverride = OPENCODE_SESSION_OPTION_CATALOG.modelApply.agentArgsOverride!
    for (const tokens of [
      ['-m', 'opencode/gpt-5.4-mini'],
      ['-mopencode/gpt-5.4-mini'],
      ['--model', 'opencode/gpt-5.4-mini'],
      ['--model=opencode/gpt-5.4-mini']
    ]) {
      expect(modelOverride(tokens)).toBe(true)
    }
    expect(modelOverride(['--model-context', '8000'])).toBe(false)
    expect(modelOverride(['summarize-my-diff'])).toBe(false)
    expect(modelOverride([])).toBe(false)
  })

  it('treats a successful discovery as authoritative over the seed', () => {
    // OpenCode's available models are host/provider-dependent, so a seed id the
    // host cannot launch must be droppable by the probe.
    expect(OPENCODE_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBe(true)
    const merged = mergeDiscoveredAuthoritativeModels(OPENCODE_SESSION_OPTION_CATALOG.models, [
      { id: 'openrouter/~openai/gpt-latest', label: 'GPT', options: [] }
    ])
    expect(merged.map(({ id }) => id)).toEqual(['openrouter/~openai/gpt-latest'])
  })

  it('parses `opencode models` line output into catalog models', () => {
    const stdout = [
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      'openrouter/~anthropic/claude-sonnet-latest',
      ''
    ].join('\n')
    const parsed = OPENCODE_SESSION_OPTION_CATALOG.listModels!.parse(stdout)
    expect(parsed.map(({ id, options }) => ({ id, options }))).toEqual([
      { id: 'opencode/big-pickle', options: [] },
      { id: 'opencode/deepseek-v4-flash-free', options: [] },
      { id: 'openrouter/~anthropic/claude-sonnet-latest', options: [] }
    ])
  })
})
