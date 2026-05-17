import { describe, expect, it, vi } from 'vitest'
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import { applyTerminalAppearance } from './terminal-appearance'

describe('terminal inactive cursor style', () => {
  it('keeps blurred non-block cursors from rendering as an outline box', () => {
    const options = {
      cursorStyle: 'block' as const,
      cursorInactiveStyle: 'outline' as const
    }
    const terminal = {
      options,
      cols: 80,
      rows: 24
    } as unknown as ManagedPane['terminal']
    const pane = { id: 1, terminal } as ManagedPane
    const manager = {
      getPanes: () => [pane],
      setPaneLigaturesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
    const settings = {
      ...getDefaultSettings('/tmp'),
      terminalCursorStyle: 'bar' as const
    }

    applyTerminalAppearance(
      manager,
      settings,
      false,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )

    expect(options.cursorStyle).toBe('bar')
    expect(options.cursorInactiveStyle).toBe('bar')
  })
})
