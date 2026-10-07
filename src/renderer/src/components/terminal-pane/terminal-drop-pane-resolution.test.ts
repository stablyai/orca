// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  resolveInternalTerminalDropPane,
  resolveNativeTerminalDropPane
} from './terminal-drop-pane-resolution'

describe('terminal drop pane resolution', () => {
  const container = document.createElement('div')
  const child = document.createElement('span')
  container.append(child)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Resolution only reads leaf identity and DOM containment.
  const pane = {
    id: 1,
    leafId: '00000000-0000-4000-8000-000000000001',
    container
  } as unknown as ManagedPane
  const getActivePane = vi.fn(() => pane)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Resolution only enumerates panes; active-pane access must stay unused.
  const manager = { getPanes: () => [pane], getActivePane } as unknown as PaneManager

  it('refuses missing or stale native leaves without consulting focus', () => {
    expect(resolveNativeTerminalDropPane(manager, undefined)).toBeNull()
    expect(resolveNativeTerminalDropPane(manager, 'stale-leaf')).toBeNull()
    expect(getActivePane).not.toHaveBeenCalled()
  })

  it('refuses missing, outside, and stale internal destinations', () => {
    expect(resolveInternalTerminalDropPane(manager, undefined)).toBeNull()
    expect(resolveInternalTerminalDropPane(manager, document.createElement('div'))).toBeNull()
    expect(resolveInternalTerminalDropPane(manager, child, 'stale-leaf')).toBeNull()
    expect(getActivePane).not.toHaveBeenCalled()
  })

  it('resolves internal pane content by DOM containment', () => {
    expect(resolveInternalTerminalDropPane(manager, child)).toBe(pane)
  })
})
