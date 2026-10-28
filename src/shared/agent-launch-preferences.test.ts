import { describe, expect, it } from 'vitest'
import { toAgentLaunchPreferences } from './agent-launch-preferences'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import {
  decodeCatalogOptionValue,
  encodeCatalogOptionValue
} from './structured-agent-session-option-codec'

describe('toAgentLaunchPreferences', () => {
  it('keeps the strict preferences, with a mode only where the agent has a terminal flag', () => {
    const options = { model: ' gpt-5 ', effort: 'high', permissionMode: 'ask', fastMode: true }
    expect(toAgentLaunchPreferences(options, 'codex')).toEqual({
      model: 'gpt-5',
      effort: 'high',
      mode: 'ask'
    })
    // OpenCode's terminal has no permission flag; a released host refuses any option it gets.
    expect(toAgentLaunchPreferences({ permissionMode: 'ask' }, 'opencode')).toBeUndefined()
    expect(toAgentLaunchPreferences({ permissionMode: 'own' }, 'opencode')).toBeUndefined()
    expect(toAgentLaunchPreferences({ permissionMode: 'own' }, 'codex')).toEqual({ mode: 'own' })
    expect(toAgentLaunchPreferences({ permissionMode: 'own' }, 'goose')).toEqual({ mode: 'own' })
    expect(toAgentLaunchPreferences({ permissionMode: 'ask' }, 'antigravity')).toBeUndefined()
  })

  it('answers nothing when no preference survives', () => {
    expect(toAgentLaunchPreferences({ model: '  ', fastMode: true }, 'codex')).toBeUndefined()
    expect(toAgentLaunchPreferences(undefined, 'codex')).toBeUndefined()
  })
})

describe('a saved boolean option across the wire', () => {
  it('round-trips Cursor Thinking into the composed terminal model', () => {
    const thinking = getAgentSessionOptionCatalog('cursor')!
      .models.find((model) => model.id === 'claude-opus-4-8')!
      .options.find((option) => option.id === 'thinking')!
    const saved = encodeCatalogOptionValue(thinking.kind, true)
    expect(saved).toBe('true')
    expect(decodeCatalogOptionValue(thinking.kind, saved!)).toBe(true)
    const options = { model: 'claude-opus-4-8', thinking: saved!, effort: 'high' }
    expect(toAgentLaunchPreferences(options, 'cursor')?.model).toBe('claude-opus-4-8-thinking-high')
    expect(resolveAgentSessionOptionLaunch('cursor', options).args).toEqual([
      '--model',
      'claude-opus-4-8-thinking-high'
    ])
  })

  it('carries a saved permission mode on the existing mode key', () => {
    expect(toAgentLaunchPreferences({ permissionMode: 'full-access' }, 'claude')).toEqual({
      mode: 'full-access'
    })
  })
})
