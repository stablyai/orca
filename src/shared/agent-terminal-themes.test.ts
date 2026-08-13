import { describe, expect, it } from 'vitest'
import { CUSTOM_TERMINAL_THEME_PREFIX } from './terminal-custom-themes'
import {
  AGENT_TERMINAL_THEME_INHERIT,
  normalizeAgentTerminalThemes,
  resolveAgentThemeSelection,
  upsertAgentTerminalThemeSlot
} from './agent-terminal-themes'

describe('normalizeAgentTerminalThemes', () => {
  it.each([undefined, null, 12, 'codex', [], true])('returns {} for non-object %j', (value) => {
    expect(normalizeAgentTerminalThemes(value)).toEqual({})
  })

  it('drops keys that are not TuiAgent ids', () => {
    expect(
      normalizeAgentTerminalThemes({
        notAnAgent: { dark: 'Ghostty Default Style Dark' },
        codex: { dark: 'Ghostty Default Style Dark' }
      })
    ).toEqual({
      codex: { dark: 'Ghostty Default Style Dark' }
    })
  })

  it("strips inherit, empty, and non-string slots", () => {
    expect(
      normalizeAgentTerminalThemes({
        codex: {
          dark: AGENT_TERMINAL_THEME_INHERIT,
          light: '  '
        },
        claude: {
          dark: 12,
          light: 'Builtin Tango Light'
        }
      })
    ).toEqual({
      claude: { light: 'Builtin Tango Light' }
    })
  })

  it('drops an agent key when both slots are omitted after sanitize', () => {
    expect(
      normalizeAgentTerminalThemes({
        grok: { dark: AGENT_TERMINAL_THEME_INHERIT, extra: 'x' },
        cursor: {}
      })
    ).toEqual({})
  })

  it('keeps custom: ids and trims builtin names without catalog validation', () => {
    const customId = `${CUSTOM_TERMINAL_THEME_PREFIX}abc-123`
    expect(
      normalizeAgentTerminalThemes({
        codex: { dark: `  ${customId}  `, light: '  Unknown Theme  ' }
      })
    ).toEqual({
      codex: { dark: customId, light: 'Unknown Theme' }
    })
  })
})

describe('upsertAgentTerminalThemeSlot', () => {
  it('writes a slot and preserves the other', () => {
    expect(
      upsertAgentTerminalThemeSlot({ claude: { dark: 'A' } }, 'claude', 'light', 'B')
    ).toEqual({
      claude: { dark: 'A', light: 'B' }
    })
  })

  it('deletes a slot on inherit and drops the agent key when empty', () => {
    expect(
      upsertAgentTerminalThemeSlot(
        { claude: { dark: 'A' }, codex: { light: 'B' } },
        'claude',
        'dark',
        AGENT_TERMINAL_THEME_INHERIT
      )
    ).toEqual({
      codex: { light: 'B' }
    })
  })

  it('deletes only the targeted slot when the other remains', () => {
    expect(
      upsertAgentTerminalThemeSlot(
        { claude: { dark: 'A', light: 'B' } },
        'claude',
        'dark',
        AGENT_TERMINAL_THEME_INHERIT
      )
    ).toEqual({
      claude: { light: 'B' }
    })
  })
})

describe('resolveAgentThemeSelection', () => {
  const globals = {
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalThemeLight: 'Builtin Tango Light',
    terminalUseSeparateLightTheme: true,
    agentTerminalThemes: { codex: { dark: 'Codex Dark', light: 'Codex Light' } }
  }

  it('returns the agent slot override when present', () => {
    expect(resolveAgentThemeSelection(globals, 'dark', 'codex')).toBe('Codex Dark')
    expect(resolveAgentThemeSelection(globals, 'light', 'codex')).toBe('Codex Light')
  })

  it('falls back to the matching global when the agent slot is missing', () => {
    expect(resolveAgentThemeSelection(globals, 'dark', 'claude')).toBe(globals.terminalThemeDark)
    expect(resolveAgentThemeSelection(globals, 'light', 'claude')).toBe(globals.terminalThemeLight)
    expect(resolveAgentThemeSelection(globals, 'dark')).toBe(globals.terminalThemeDark)
  })

  it('uses the dark global for the light slot when Match dark mode is on', () => {
    expect(
      resolveAgentThemeSelection(
        { ...globals, terminalUseSeparateLightTheme: false },
        'light',
        'claude'
      )
    ).toBe(globals.terminalThemeDark)
  })
})
