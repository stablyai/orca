import { describe, expect, it, vi } from 'vitest'
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import { applyTerminalAppearance } from './terminal-appearance'

function applyWithSetting(terminalMouseEventsRequireAlt: boolean | undefined): {
  mouseEventsRequireAlt?: boolean
} {
  const options = { mouseEventsRequireAlt: undefined as boolean | undefined }
  const terminal = { options, cols: 80, rows: 24 } as unknown as ManagedPane['terminal']
  const manager = {
    getPanes: () => [{ id: 1, terminal } as ManagedPane],
    setPaneLigaturesEnabled: vi.fn(),
    setPaneStyleOptions: vi.fn()
  } as unknown as PaneManager

  applyTerminalAppearance(
    manager,
    { ...getDefaultSettings('/tmp'), terminalMouseEventsRequireAlt },
    false,
    new Map(),
    new Map(),
    'false',
    new Map(),
    new Map()
  )
  return options
}

describe('terminalMouseEventsRequireAlt', () => {
  it('defaults off so clicking a mouse-tracking TUI keeps working', () => {
    expect(getDefaultSettings('/tmp').terminalMouseEventsRequireAlt).toBe(false)
  })

  it.each([
    { setting: true, applied: true },
    { setting: false, applied: false },
    // Profiles saved before this setting existed must not gate clicks.
    { setting: undefined, applied: false }
  ])('applies $setting to xterm as $applied', ({ setting, applied }) => {
    expect(applyWithSetting(setting).mouseEventsRequireAlt).toBe(applied)
  })
})
