import { describe, expect, it } from 'vitest'
import {
  createPresetOpenInApplication,
  shouldCommitOpenInApplicationsDraft
} from './OpenInMenuSetting'
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

  it('offers IntelliJ IDEA with the Toolbox launcher command and a bundled icon', () => {
    const idea = requirePreset('intellij-idea')

    expect(idea.command).toBe('idea')
    expect(typeof idea.iconSrc === 'string' && idea.iconSrc.length > 0).toBe(true)
  })

  it('renders the bundled product icon for the IntelliJ IDEA preset', () => {
    const icon = OpenInApplicationIcon({ application: { command: 'idea' } })

    // Bundled asset (data URI or hashed .svg), never the shared favicon fallback.
    expect(icon.props.src).not.toContain('google.com/s2/favicons')
    expect(icon.props.src).toMatch(/^data:image\/svg|\.svg$/)
  })

  it('creates a stable row for the IntelliJ IDEA preset', () => {
    const idea = requirePreset('intellij-idea')

    expect(createPresetOpenInApplication(idea)).toEqual({
      id: 'intellij-idea',
      label: 'IntelliJ IDEA',
      command: 'idea'
    })
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
