import { describe, expect, it } from 'vitest'
import {
  createPresetOpenInApplication,
  shouldCommitOpenInApplicationsDraft
} from './OpenInMenuSetting'
import {
  getOpenInAppPreset,
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

  it.each([
    ['windsurf', 'Windsurf', 'windsurf'],
    ['devin-desktop', 'Devin Desktop', 'devin']
  ])('creates a stable preset row for %s', (id, label, command) => {
    expect(createPresetOpenInApplication(requirePreset(id))).toEqual({ id, label, command })
  })

  it('recognizes an added Windsurf or Devin row so the picker cannot duplicate it', () => {
    for (const [id, command] of [
      ['windsurf', ' Windsurf '],
      ['devin-desktop', 'DEVIN']
    ]) {
      const preset = requirePreset(id)
      expect(isOpenInAppPresetAdded([{ command }], preset)).toBe(true)
      expect(isOpenInAppPresetAdded([{ command: 'code' }], preset)).toBe(false)
    }
  })

  it('keeps every preset command unique and matchable', () => {
    const presets = getOpenInAppPresets()
    const commands = presets.map((preset) => preset.command)
    // getOpenInAppPreset matches on a lowercased command, so a preset whose own
    // command is not lowercase could never resolve its icon.
    expect(commands).toEqual(commands.map((command) => command.toLowerCase()))
    expect(new Set(commands).size).toBe(commands.length)
    expect(new Set(presets.map((preset) => preset.id)).size).toBe(commands.length)
    for (const preset of presets) {
      expect(getOpenInAppPreset({ command: `  ${preset.command.toUpperCase()}  ` })).toBe(preset)
    }
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
