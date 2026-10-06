import { describe, expect, it } from 'vitest'
import {
  deriveOmarchyCssVars,
  deriveOmarchyMonacoColors,
  deriveOmarchyPalette,
  deriveOmarchyTerminalColors,
  OMARCHY_SEED_COLOR_KEYS,
  parseOmarchyThemeSeed,
  type OmarchyThemeSeed
} from './omarchy-theme-palette'

function seedJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = { mode: 'dark' }
  OMARCHY_SEED_COLOR_KEYS.forEach((key, index) => {
    base[key] = `#${index.toString(16).padStart(2, '0')}a0b0`
  })
  return {
    ...base,
    background: '#0a1220',
    foreground: '#f0f2f5',
    dark_background: '#080e18',
    accent: '#B8B8B6',
    green: '#889889',
    red: '#e06b58',
    ...overrides
  }
}

function parseSeed(overrides: Record<string, unknown> = {}): OmarchyThemeSeed {
  const seed = parseOmarchyThemeSeed(JSON.stringify(seedJson(overrides)))
  if (!seed) {
    throw new Error('expected a valid seed')
  }
  return seed
}

describe('parseOmarchyThemeSeed', () => {
  it('accepts a complete seed and lowercases hex values', () => {
    const seed = parseSeed()
    expect(seed.mode).toBe('dark')
    expect(seed.accent).toBe('#b8b8b6')
    expect(seed.background).toBe('#0a1220')
  })

  it('rejects unresolved Omarchy placeholders', () => {
    const text = JSON.stringify(seedJson()).replace('#0a1220', '{{ background }}')
    expect(parseOmarchyThemeSeed(text)).toBeNull()
  })

  it('rejects malformed JSON, missing keys, non-hex colors and unknown modes', () => {
    expect(parseOmarchyThemeSeed('{"mode": "dark",')).toBeNull()
    expect(parseOmarchyThemeSeed('[]')).toBeNull()
    const missing = seedJson()
    delete missing.color15
    expect(parseOmarchyThemeSeed(JSON.stringify(missing))).toBeNull()
    expect(parseOmarchyThemeSeed(JSON.stringify(seedJson({ red: '#fff' })))).toBeNull()
    expect(parseOmarchyThemeSeed(JSON.stringify(seedJson({ red: 'rgb(1,2,3)' })))).toBeNull()
    expect(parseOmarchyThemeSeed(JSON.stringify(seedJson({ mode: 'dim' })))).toBeNull()
  })
})

describe('deriveOmarchyCssVars', () => {
  it('maps the seed onto core, sidebar, chat, diff, git and status families', () => {
    const vars = deriveOmarchyCssVars(parseSeed())
    expect(vars['--background']).toBe('#0a1220')
    expect(vars['--foreground']).toBe('#f0f2f5')
    expect(vars['--primary']).toBe('#b8b8b6')
    expect(vars['--sidebar']).toBe('#080e18')
    expect(vars['--worktree-sidebar']).toBe('#080e18')
    expect(vars['--chat-canvas']).toBe('color-mix(in srgb, #f0f2f5 5%, #0a1220)')
    expect(vars['--diff-added-ground']).toBe('color-mix(in srgb, #889889 16%, #0a1220)')
    expect(vars['--diff-removed-gutter']).toBe('color-mix(in srgb, #e06b58 32%, #0a1220)')
    expect(vars['--git-decoration-deleted']).toBe('#e06b58')
    expect(vars['--git-graph-lane-1']).toBe('#b8b8b6')
    expect(vars['--status-success']).toBe('#889889')
    expect(vars['--editor-surface']).toBe('#0a1220')
    for (const name of [
      '--card',
      '--popover',
      '--secondary',
      '--muted',
      '--accent',
      '--border',
      '--input',
      '--ring',
      '--destructive',
      '--chart-5',
      '--workspace-status-done'
    ]) {
      expect(vars[name], name).toBeTruthy()
    }
  })

  it('never themes security or layout variables', () => {
    const names = Object.keys(deriveOmarchyCssVars(parseSeed()))
    expect(names.some((name) => name.startsWith('--orca-security-'))).toBe(false)
    expect(names).not.toContain('--chat-content-max-width')
  })

  it('emits only the terminal title family matching the mode', () => {
    const darkVars = deriveOmarchyCssVars(parseSeed())
    expect(darkVars['--terminal-pane-title-on-dark-fg']).toBeDefined()
    expect(darkVars['--terminal-pane-title-on-light-fg']).toBeUndefined()
    expect(darkVars['--chat-canvas']).not.toBe('#0a1220')

    const lightVars = deriveOmarchyCssVars(
      parseSeed({ mode: 'light', background: '#fafafa', foreground: '#202020' })
    )
    expect(lightVars['--terminal-pane-title-on-light-fg']).toBeDefined()
    expect(lightVars['--terminal-pane-title-on-dark-fg']).toBeUndefined()
    expect(lightVars['--chat-canvas']).toBe('#fafafa')
    expect(lightVars['--diff-added-ground']).toBe('color-mix(in srgb, #889889 13%, #fafafa)')
  })
})

describe('Omarchy terminal and Monaco colors', () => {
  it('maps the ANSI palette and terminal fields onto xterm keys', () => {
    const seed = parseSeed()
    const terminal = deriveOmarchyTerminalColors(seed)
    expect(terminal.background).toBe('#0a1220')
    expect(terminal.cursor).toBe(seed.terminal_cursor)
    expect(terminal.selectionBackground).toBe(seed.terminal_selection)
    expect(terminal.black).toBe(seed.color0)
    expect(terminal.brightWhite).toBe(seed.color15)
  })

  it('produces only hex values Monaco accepts', () => {
    const colors = deriveOmarchyMonacoColors(parseSeed())
    expect(colors['editor.background']).toBe('#0a1220')
    for (const value of Object.values(colors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    }
  })

  it('bundles the seed with its derived vars', () => {
    const seed = parseSeed()
    expect(deriveOmarchyPalette(seed)).toEqual({ seed, cssVars: deriveOmarchyCssVars(seed) })
  })
})
