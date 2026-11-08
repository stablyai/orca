import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../../shared/constants'
import { applyTerminalAppearance } from './terminal-appearance'

import { safeFit } from '@/lib/pane-manager/pane-fit'
import { _resetTerminalViewAttributesPublisherForTest } from './terminal-view-attributes-publisher'
describe('applyTerminalAppearance theme assignment', () => {
  // xterm rebuilds the palette on any new theme-object identity (wiping OSC color mutations), so the assignment must be value-gated.
  // Metric writes require a measurable pane; hidden panes defer until fit/reveal.
  function makePane(id: number, overrides?: { measurable?: boolean }): ManagedPane {
    const measurable = overrides?.measurable ?? true
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the pane members exercised by appearance logic.
    return {
      id,
      terminal: { options: {}, cols: 80, rows: 24 },
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: measurable ? 800 : 0, height: measurable ? 600 : 0 })
      },
      fitAddon: {
        proposeDimensions: () => (measurable ? { cols: 80, rows: 24 } : undefined)
      }
    } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members exercised by appearance logic.
    return {
      // Real getPanes returns fresh wrappers around the same terminal; per-pane state must survive wrapper changes.
      getPanes: () => panes.map((pane) => ({ ...pane })),
      setPaneLigaturesEnabled: vi.fn(),
      setPaneInlineImagesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
  }

  function apply(pane: ManagedPane, settings: ReturnType<typeof getDefaultSettings>): void {
    applyTerminalAppearance(
      makeManager([pane]),
      settings,
      true,
      new Map(),
      'false',
      new Map(),
      new Map()
    )
  }

  it('keeps options.theme identity across attribute-neutral applies (font size tweak)', () => {
    const pane = makePane(1)
    const settings = getDefaultSettings('/tmp')

    apply(pane, settings)
    const firstTheme = pane.terminal.options.theme
    expect(firstTheme).toBeDefined()

    apply(pane, { ...settings, terminalFontSize: settings.terminalFontSize + 2 })

    // Identity-stable theme means xterm never re-runs _setTheme, so a TUI's modifyColors mutation survives the font tweak.
    expect(pane.terminal.options.theme).toBe(firstTheme)
    expect(pane.terminal.options.fontSize).toBe(settings.terminalFontSize + 2)
  })

  it('applies only the latest deferred metric options after repeated hidden changes', () => {
    let measurable = false
    const writes: number[] = []
    const options: Record<string, unknown> = {}
    Object.defineProperty(options, 'fontSize', {
      configurable: true,
      enumerable: true,
      get: () => writes.at(-1),
      set: (value: number) => {
        writes.push(value)
      }
    })
    const pane = {
      id: 1,
      terminal: { options, cols: 80, rows: 24 },
      container: {
        dataset: {},
        getBoundingClientRect: () => ({ width: measurable ? 800 : 0, height: measurable ? 600 : 0 })
      },
      fitAddon: {
        fit: vi.fn(),
        proposeDimensions: () => (measurable ? { cols: 80, rows: 24 } : undefined)
      }
    } as unknown as ManagedPane
    const settings = getDefaultSettings('/tmp')

    apply(pane, { ...settings, terminalFontSize: 15 })
    apply(pane, { ...settings, terminalFontSize: 21 })

    measurable = true
    safeFit(pane)

    expect(writes).toEqual([21])
  })
})
