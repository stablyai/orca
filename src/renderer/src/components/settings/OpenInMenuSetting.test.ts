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

  it('offers the JetBrains IDE suite as grouped presets', () => {
    const jetbrains = getOpenInAppPresets().filter((preset) => preset.group === 'jetbrains')

    expect(jetbrains.map((preset) => preset.command)).toEqual([
      'idea',
      'webstorm',
      'pycharm',
      'phpstorm',
      'goland',
      'rider',
      'clion',
      'rubymine',
      'datagrip',
      'rustrover'
    ])
    const iconSrcs = jetbrains.map((preset) => preset.iconSrc)
    expect(iconSrcs.every((src) => typeof src === 'string' && src.length > 0)).toBe(true)
    expect(new Set(iconSrcs).size).toBe(jetbrains.length)
  })

  it('renders the bundled product icon for JetBrains presets', () => {
    const icon = OpenInApplicationIcon({ application: { command: 'webstorm' } })

    // Bundled asset (data URI or hashed .svg), never the shared favicon fallback.
    expect(icon.props.src).not.toContain('google.com/s2/favicons')
    expect(icon.props.src).toMatch(/^data:image\/svg|\.svg$/)
  })

  it('renders every preset in one of the Add app menu partitions', () => {
    const presets = getOpenInAppPresets()
    const standalone = presets.filter((preset) => preset.group === undefined)
    const jetbrains = presets.filter((preset) => preset.group === 'jetbrains')

    // Why: the Add app dropdown renders exactly these two partitions; a new
    // group literal needs its own submenu there or its presets silently vanish.
    expect(standalone.length + jetbrains.length).toBe(presets.length)
  })

  it('creates stable rows for JetBrains presets', () => {
    const webstorm = requirePreset('webstorm')

    expect(createPresetOpenInApplication(webstorm)).toEqual({
      id: 'webstorm',
      label: 'WebStorm',
      command: 'webstorm'
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
