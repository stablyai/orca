import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { fitAndFocusPanes, isWindowsUserAgent } from './pane-helpers'

describe('isWindowsUserAgent', () => {
  it('detects Windows user agents', () => {
    expect(isWindowsUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true)
  })

  it('ignores non-Windows user agents', () => {
    expect(isWindowsUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false)
  })
})

describe('fitAndFocusPanes', () => {
  class FakeHTMLElement {
    readonly tagName: string
    readonly isContentEditable: boolean
    readonly classList: { contains: (className: string) => boolean }

    constructor(args: {
      tagName: string
      classNames?: string[]
      isContentEditable?: boolean
      closestSelector?: string | null
    }) {
      this.tagName = args.tagName
      this.isContentEditable = args.isContentEditable ?? false
      const classNames = new Set(args.classNames ?? [])
      this.classList = { contains: (className) => classNames.has(className) }
      this.closest = vi.fn((selector: string) =>
        selector === args.closestSelector ? (this as unknown as Element) : null
      )
    }

    matches = vi.fn(() => false)

    closest: (selector: string) => Element | null
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeManager(): { manager: PaneManager; terminal: { focus: ReturnType<typeof vi.fn> } } {
    const terminal = { focus: vi.fn() }
    const pane = { terminal, container: { querySelector: () => null } }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fitAndFocusPanes reads only these members, and the focus path reads only a pane's terminal and container.
    const manager = {
      fitAllPanes: vi.fn(),
      getActivePane: () => pane,
      getPanes: () => [pane]
    } as unknown as PaneManager
    return { manager, terminal }
  }

  function stubDocument(activeElement: Element | null, renameInputMounted = false): void {
    vi.stubGlobal('HTMLElement', FakeHTMLElement)
    vi.stubGlobal('document', {
      activeElement,
      querySelectorAll: vi.fn(() => []),
      querySelector: vi.fn((selector: string) =>
        selector === '[data-tab-rename-input="true"]' && renameInputMounted
          ? (new FakeHTMLElement({ tagName: 'INPUT' }) as unknown as Element)
          : null
      )
    })
  }

  it('fits without stealing focus from an active editable field', () => {
    const input = new FakeHTMLElement({ tagName: 'INPUT' }) as unknown as Element
    stubDocument(input)
    const { manager, terminal } = makeManager()

    fitAndFocusPanes(manager)

    expect(manager.fitAllPanes).toHaveBeenCalled()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('does not focus the terminal while inline tab rename is mounting', () => {
    stubDocument(null, true)
    const { manager, terminal } = makeManager()

    fitAndFocusPanes(manager)

    expect(manager.fitAllPanes).toHaveBeenCalled()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('still focuses the active terminal pane when the current focus is xterm', () => {
    const textarea = new FakeHTMLElement({
      tagName: 'TEXTAREA',
      classNames: ['xterm-helper-textarea']
    }) as unknown as Element
    stubDocument(textarea)
    const { manager, terminal } = makeManager()

    fitAndFocusPanes(manager)

    expect(manager.fitAllPanes).toHaveBeenCalled()
    expect(terminal.focus).toHaveBeenCalled()
  })
})
