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

  it('exposes Antigravity as a built-in preset with a bundled icon', () => {
    const antigravity = requirePreset('antigravity')

    expect(createPresetOpenInApplication(antigravity)).toEqual({
      id: 'antigravity',
      label: 'Antigravity',
      command: 'antigravity'
    })
    expect(isOpenInAppPresetAdded([{ command: ' Antigravity ' }], antigravity)).toBe(true)
    // Bundled asset, not the (unreliable) favicon service for antigravity.google.
    expect(antigravity.iconUrl).toBeTruthy()
    const icon = OpenInApplicationIcon({ application: { command: 'antigravity' } })
    expect(icon.props.src).not.toContain('s2/favicons')
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
