import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { resolveCommentMermaidDarkMode } from './CommentMermaidBlock'

function settings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings(tmpdir()), ...overrides }
}

describe('resolveCommentMermaidDarkMode', () => {
  it('uses the terminal-driven App Appearance scheme', () => {
    expect(
      resolveCommentMermaidDarkMode(
        settings({
          theme: 'light',
          leftSidebarAppearanceMode: 'match-terminal',
          terminalColorOverrides: { background: '#101820' },
          terminalBackgroundOpacity: 1
        }),
        false
      )
    ).toBe(true)
  })

  it('falls back to the configured app scheme', () => {
    expect(resolveCommentMermaidDarkMode(settings({ theme: 'light' }), true)).toBe(false)
  })

  it('keeps editor Mermaid on the configured scheme', () => {
    expect(
      resolveCommentMermaidDarkMode(
        settings({
          theme: 'light',
          leftSidebarAppearanceMode: 'match-terminal',
          terminalColorOverrides: { background: '#101820' }
        }),
        false,
        'editor'
      )
    ).toBe(false)
  })
})
