import { describe, expect, it } from 'vitest'
import {
  createPresetOpenInApplication,
  shouldCommitOpenInApplicationsDraft,
  withOpenInApplicationIcon
} from './OpenInMenuSetting'
import { getOpenInAppIconGlyph } from '@/lib/open-in-app-icon-set'
import {
  getOpenInAppPresets,
  isOpenInAppPresetAdded,
  OpenInApplicationIcon
} from '@/lib/open-in-app-catalog'
import type { OpenInAppPreset } from '@/lib/open-in-app-catalog'

function requirePreset(id: string): OpenInAppPreset {
  const preset = getOpenInAppPresets().find((entry) => entry.id === id)
  if (!preset) {
    throw new Error(`Preset not found: ${id}`)
  }
  return preset
}

describe('OpenInMenuSetting presets', () => {
  it('creates stable preset rows for known apps', () => {
    const cursor = requirePreset('cursor')

    expect(createPresetOpenInApplication(cursor)).toEqual({
      id: 'cursor',
      label: 'Cursor',
      command: 'cursor'
    })
  })

  it('recognizes legacy preset rows by command', () => {
    const cursor = requirePreset('cursor')

    expect(isOpenInAppPresetAdded([{ command: ' cursor ' }], cursor)).toBe(true)
  })

  it('keeps the Zed icon visible on dark menus', () => {
    const icon = OpenInApplicationIcon({ application: { command: 'zed' } })

    expect(icon.props.className).toContain('dark:invert')
  })
})

describe('OpenInMenuSetting custom icons', () => {
  it('prefers a chosen bundled icon over the command preset favicon', () => {
    const chosen = OpenInApplicationIcon({
      application: { command: 'zed', icon: { type: 'bundled', id: 'Braces' } }
    })
    const preset = OpenInApplicationIcon({ application: { command: 'zed' } })

    expect(chosen.type).toBe(getOpenInAppIconGlyph('Braces'))
    expect(preset.type).toBe('img')
  })

  it('renders an icon extracted from an installed app', () => {
    const src = 'data:image/png;base64,aGk='
    const icon = OpenInApplicationIcon({
      application: { command: 'idea', icon: { type: 'image', src } }
    })

    expect(icon.type).toBe('img')
    expect(icon.props.src).toBe(src)
  })

  it('falls back to the generic glyph when a row has neither icon nor preset', () => {
    const icon = OpenInApplicationIcon({ application: { command: 'idea' } })

    expect(icon.type).not.toBe('img')
  })

  it('sets and clears a row icon without leaving the key behind', () => {
    const application = { id: 'idea', label: 'IntelliJ IDEA', command: 'idea' }
    const icon = { type: 'bundled', id: 'Braces' } as const

    const withIcon = withOpenInApplicationIcon(application, icon)
    expect(withIcon).toEqual({ ...application, icon })

    const cleared = withOpenInApplicationIcon(withIcon, null)
    expect(cleared).toEqual(application)
    expect(cleared).not.toHaveProperty('icon')
  })
})

describe('OpenInMenuSetting application drafts', () => {
  it('does not commit rows until both label and command are present', () => {
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: 'Cursor', command: '' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: '', command: 'cursor' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: '   ', command: 'cursor' }])
    ).toBe(false)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'draft', label: 'Cursor', command: '   ' }])
    ).toBe(false)
  })

  it('allows commit when every draft row has a label and command', () => {
    expect(shouldCommitOpenInApplicationsDraft([])).toBe(true)
    expect(
      shouldCommitOpenInApplicationsDraft([{ id: 'cursor', label: 'Cursor', command: 'cursor' }])
    ).toBe(true)
    expect(
      shouldCommitOpenInApplicationsDraft([
        { id: 'cursor', label: 'Cursor', command: 'cursor' },
        { id: 'zed', label: 'Zed', command: 'zed' }
      ])
    ).toBe(true)
  })
})
