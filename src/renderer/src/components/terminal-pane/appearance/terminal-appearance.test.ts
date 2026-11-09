import { describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { TerminalViewAttributes } from '../../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import {
  applyTerminalAppearance,
  hexToRgba,
  publishTerminalViewAttributesAtAppStart
} from './terminal-appearance'

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

describe('publishTerminalViewAttributesAtAppStart', () => {
  // Hidden-at-launch PTYs query OSC 10/11 before any pane mounts; publish with no pane manager (terminal-query-authority.md).
  it('publishes composed attributes without any pane mount and dedupes repeats', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: TerminalViewAttributes[] = []
    const send = (attributes: TerminalViewAttributes): boolean => {
      sent.push(attributes)
      return true
    }
    const settings = getDefaultSettings('/tmp')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.ansi).toHaveLength(256)
    expect(sent[0]!.cursorStyle).toBe(settings.terminalCursorStyle ?? 'block')

    expect(publishTerminalViewAttributesAtAppStart(settings, true, send)).toBe(false)
    expect(sent).toHaveLength(1)
  })

  it('makes the later pane-mount applyTerminalAppearance a deduped no-op re-push', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const publishMock = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { pty: { publishTerminalViewAttributes: publishMock } }
    }
    try {
      const settings = getDefaultSettings('/tmp')
      publishTerminalViewAttributesAtAppStart(settings, true)
      expect(publishMock).toHaveBeenCalledTimes(1)

      // Identical app-global snapshot, so the publisher dedupe keeps it a single push.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the manager members exercised by appearance publication.
      const manager = {
        getPanes: () => [],
        setPaneLigaturesEnabled: vi.fn(),
        setPaneInlineImagesEnabled: vi.fn(),
        setPaneStyleOptions: vi.fn()
      } as unknown as PaneManager
      applyTerminalAppearance(manager, settings, true, new Map(), 'false', new Map(), new Map())
      expect(publishMock).toHaveBeenCalledTimes(1)
    } finally {
      delete (globalThis as { window?: unknown }).window
      _resetTerminalViewAttributesPublisherForTest()
    }
  })

  it('publishes nothing before settings are loaded', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributesAtAppStart(null, true, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('aligns published colorSchemeMode with terminal background polarity when terminalUseSeparateLightTheme is false', () => {
    _resetTerminalViewAttributesPublisherForTest()
    const sent: unknown[] = []
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'light' as const,
      terminalUseSeparateLightTheme: false
    }
    expect(
      publishTerminalViewAttributesAtAppStart(settings, false, (attrs) => {
        sent.push(attrs)
        return true
      })
    ).toBe(true)
    expect(sent[0]).toMatchObject({ colorSchemeMode: 'dark' })
  })
})

describe('hexToRgba', () => {
  it('converts 6-char hex to rgba', () => {
    expect(hexToRgba('#1a1a1a', 0.72)).toBe('rgba(26, 26, 26, 0.72)')
  })

  it('converts 3-char shorthand hex to rgba', () => {
    expect(hexToRgba('#f0f', 0.5)).toBe('rgba(255, 0, 255, 0.5)')
  })

  it('handles full opacity', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)')
  })

  it('handles zero opacity', () => {
    expect(hexToRgba('#ffffff', 0)).toBe('rgba(255, 255, 255, 0)')
  })
})
