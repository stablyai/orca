// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@xterm/xterm', () => {
  class Terminal {
    options: Record<string, unknown>
    element: HTMLElement | null = null
    unicode = { activeVersion: '' }

    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
    }

    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      container.appendChild(this.element)
    }

    focus(): void {}
    loadAddon(): void {}
    dispose(): void {}
    clear(): void {}
    paste(): void {}
    getSelection(): string {
      return ''
    }
  }

  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss(): void {}
    dispose(): void {}
  }
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    dispose(): void {}
  }
}))

import { PaneManager, type ActivePaneChangeReason, type ManagedPane } from './pane-manager'

describe('PaneManager focus-follows-mouse', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function createTwoPaneManager(
    onActivePaneChange?: (pane: ManagedPane, reason: ActivePaneChangeReason) => void
  ): { manager: PaneManager; panes: ManagedPane[]; root: HTMLDivElement } {
    const root = document.createElement('div')
    document.body.appendChild(root)

    const manager = new PaneManager(root, { onActivePaneChange })
    manager.setPaneStyleOptions({ focusFollowsMouse: true })

    const firstPane = manager.createInitialPane({ focus: false })
    manager.splitPane(firstPane.id, 'vertical')

    return { manager, panes: manager.getPanes(), root }
  }

  it('tags hover-driven activation with the hover reason', () => {
    const onActivePaneChange = vi.fn()
    const { manager, panes } = createTwoPaneManager(onActivePaneChange)
    const [paneA, paneB] = panes

    manager.setActivePane(paneA.id, { focus: false })
    onActivePaneChange.mockClear()

    paneB.container.dispatchEvent(new MouseEvent('mouseenter', { buttons: 0 }))

    expect(manager.getActivePane()?.id).toBe(paneB.id)
    expect(onActivePaneChange).toHaveBeenCalledOnce()
    expect(onActivePaneChange.mock.calls[0]?.[1]).toBe('hover')
  })

  it('does not switch panes while a pane-local text input is focused', () => {
    const onActivePaneChange = vi.fn()
    const { manager, panes } = createTwoPaneManager(onActivePaneChange)
    const [paneA, paneB] = panes

    manager.setActivePane(paneA.id, { focus: false })
    onActivePaneChange.mockClear()

    const renameInput = document.createElement('input')
    renameInput.className = 'pane-title-input'
    paneA.container.appendChild(renameInput)
    renameInput.focus()

    paneB.container.dispatchEvent(new MouseEvent('mouseenter', { buttons: 0 }))

    expect(document.activeElement).toBe(renameInput)
    expect(manager.getActivePane()?.id).toBe(paneA.id)
    expect(onActivePaneChange).not.toHaveBeenCalled()
  })
})
