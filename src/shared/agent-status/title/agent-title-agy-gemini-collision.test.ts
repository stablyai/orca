import { describe, expect, it } from 'vitest'
import './agent-title-identity'
import { resolveExplicitTerminalTitleAgentType } from '../../terminal-title-agent-type'
import './agent-title-core'

// agy model names include Gemini; the earlier Gemini token detector once mistook model metadata for pane identity.
describe('agy titles carrying a Gemini model name', () => {
  const AGY_TITLES = [
    '⠋ agy · Gemini 3.7 Flash · high',
    'Antigravity · Gemini 3.7 Flash',
    'agy · Gemini 3.5 Flash (High)'
  ]

  it.each(AGY_TITLES)('resolves %s as antigravity on the tab path too', (title) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe('antigravity')
  })
})
