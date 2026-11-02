/** Match xterm ThemeService defaults, cursor blend and palette while publishing app-global changes only once (terminal-query-authority.md). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager, ManagedPane } from '@/lib/pane-manager/pane-manager'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes
} from '../../../../shared/terminal-view-attributes'
import { applyTerminalAppearance } from './terminal-appearance'
import {
  _resetTerminalViewAttributesPublisherForTest,
  composeTerminalViewAttributes,
  publishTerminalViewAttributes,
  subscribeToPublishedTerminalViewAttributes
} from './terminal-view-attributes-publisher'

const cursorSettings = {
  terminalCursorStyle: 'block' as const,
  terminalCursorBlink: true
}

beforeEach(() => {
  _resetTerminalViewAttributesPublisherForTest()
  vi.unstubAllGlobals()
})

describe('composeTerminalViewAttributes', () => {
  it('parses composed theme colors including rgba() opacity forms', () => {
    const attrs = composeTerminalViewAttributes(
      {
        // Drop foreground/background alpha like xterm toColorRGB, but blend cursor alpha over the background.
        background: 'rgba(30, 30, 46, 0.9)',
        foreground: '#d0d0d0',
        cursor: 'rgba(255, 0, 0, 0.5)',
        red: '#ff8800'
      },
      'light',
      { terminalCursorStyle: 'underline', terminalCursorBlink: false }
    )
    expect(attrs.background).toEqual([30, 30, 46])
    expect(attrs.foreground).toEqual([0xd0, 0xd0, 0xd0])
    // color.blend parity: a = round(0.5*255)/255; ch = bg + round((fg-bg)*a).
    expect(attrs.cursor).toEqual([143, 15, 23])
    expect(attrs.ansi[1]).toEqual([0xff, 0x88, 0x00])
    expect(attrs.colorSchemeMode).toBe('light')
    expect(attrs.cursorStyle).toBe('underline')
    expect(attrs.cursorBlink).toBe(false)
  })

  it('keeps an opaque cursor un-blended and blends short-hex alpha', () => {
    const attrs = composeTerminalViewAttributes(
      { background: '#000000', cursor: '#ff0000' },
      'dark',
      cursorSettings
    )
    expect(attrs.cursor).toEqual([255, 0, 0])

    const blended = composeTerminalViewAttributes(
      { background: '#000000', cursor: '#f00a' },
      'dark',
      cursorSettings
    )
    // #f00a → alpha 0xaa: 0 + round(255 * (0xaa/0xff)) = 170.
    expect(blended.cursor).toEqual([170, 0, 0])
  })
})

describe('publishTerminalViewAttributes dedupe', () => {
  it('does not record a failed send, so the next call retries', () => {
    const failingSend = vi.fn(() => false)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, failingSend)).toBe(false)

    const send = vi.fn(() => true)
    expect(publishTerminalViewAttributes(null, 'dark', cursorSettings, send)).toBe(true)
  })

  it('hands each published appearance to subscribers, starting with the current one', () => {
    const send = vi.fn(() => true)
    publishTerminalViewAttributes({ foreground: '#111111' }, 'dark', cursorSettings, send)
    const heard: unknown[] = []

    const unsubscribe = subscribeToPublishedTerminalViewAttributes((attributes) =>
      heard.push(terminalViewColorQueryReplyColors(attributes))
    )
    publishTerminalViewAttributes({ foreground: '#222222' }, 'dark', cursorSettings, send)
    unsubscribe()
    publishTerminalViewAttributes({ foreground: '#333333' }, 'dark', cursorSettings, send)

    expect(heard).toEqual([
      { foreground: '#111111', background: '#000000' },
      { foreground: '#222222', background: '#000000' }
    ])
  })
})

describe('applyTerminalAppearance publication', () => {
  function makePane(id: number): ManagedPane {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the pane members used by the publisher.
    return {
      id,
      terminal: { options: {}, cols: 80, rows: 24 }
    } as unknown as ManagedPane
  }

  function makeManager(panes: ManagedPane[]): PaneManager {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the pane manager members used by the publisher.
    return {
      getPanes: () => panes,
      setPaneLigaturesEnabled: vi.fn(),
      setPaneInlineImagesEnabled: vi.fn(),
      setPaneStyleOptions: vi.fn()
    } as unknown as PaneManager
  }

  function stubPublishBridge(): ReturnType<typeof vi.fn> {
    const publish = vi.fn<(attributes: TerminalViewAttributes) => void>()
    vi.stubGlobal('window', { api: { pty: { publishTerminalViewAttributes: publish } } })
    return publish
  }

  it('pushes the app-global snapshot once per change, not per pane or per manager', () => {
    const publish = stubPublishBridge()
    const settings = getDefaultSettings('/tmp')

    // App-global snapshots dedupe across panes and managers.
    applyTerminalAppearance(
      makeManager([makePane(1), makePane(2)]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    applyTerminalAppearance(
      makeManager([makePane(3)]),
      settings,
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(1)
    const attributes = publish.mock.calls[0][0] as TerminalViewAttributes
    expect(attributes.ansi).toHaveLength(256)
    expect(attributes.cursorStyle).toBe(settings.terminalCursorStyle)

    applyTerminalAppearance(
      makeManager([makePane(1)]),
      { ...settings, terminalFontSize: settings.terminalFontSize + 2 },
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(1)

    applyTerminalAppearance(
      makeManager([makePane(1)]),
      { ...settings, terminalCursorStyle: 'underline' },
      true,
      new Map(),
      new Map(),
      'false',
      new Map(),
      new Map()
    )
    expect(publish).toHaveBeenCalledTimes(2)
  })
})
