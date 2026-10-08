// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneManager } from './pane-manager'
import { createInitialManagedPane } from './pane-manager-pane-creation'
import { focusPanePreservingOverlays } from './pane-overlay-focus'
import type { PaneManagerHost } from './pane-manager-host'
import type { ManagedPaneInternal } from './pane-manager-types'

vi.mock('./pane-lifecycle', () => ({
  openTerminal: vi.fn(),
  createPaneDOM: vi.fn(),
  disposePane: vi.fn(),
  setLigaturesEnabled: vi.fn()
}))

afterEach(() => {
  document.body.innerHTML = ''
})

function fixture() {
  const root = document.createElement('div')
  document.body.append(root)
  const container = document.createElement('div')
  const textarea = document.createElement('textarea')
  container.append(textarea)
  const pane = {
    id: 1,
    container,
    terminal: { focus: vi.fn(() => textarea.focus()) }
  } as unknown as ManagedPaneInternal
  const panes = new Map([[pane.id, pane]])
  const publishPaneCreated = vi.fn()
  const onActivePaneChange = vi.fn()
  const manager = Object.create(PaneManager.prototype) as PaneManager
  Object.assign(manager, {
    panes,
    activePaneId: null,
    styleOptions: {},
    options: { onActivePaneChange }
  })
  const host = {
    options: {},
    root,
    panes,
    createPaneInternal: () => pane,
    setActivePaneId: vi.fn(),
    getActivePaneId: () => pane.id,
    getStyleOptions: () => ({}),
    publishPaneCreated
  } as unknown as PaneManagerHost
  return { root, container, textarea, pane, host, manager, publishPaneCreated, onActivePaneChange }
}

function overlay(role: string) {
  const element = document.createElement('div')
  element.setAttribute('role', role)
  element.tabIndex = -1
  document.body.append(element)
  element.focus()
  return element
}

function coverPane(f: ReturnType<typeof fixture>): HTMLElement {
  const cover = document.createElement('div')
  cover.className = 'native-chat-pane-shell'
  cover.tabIndex = -1
  f.container.append(cover)
  return cover
}

describe.each(['initial', 'active'] as const)('%s pane focus', (operation) => {
  function focus(f: ReturnType<typeof fixture>, requested = true) {
    if (operation === 'initial') {
      createInitialManagedPane(f.host, { focus: requested })
      expect(f.publishPaneCreated).toHaveBeenCalledWith(f.pane, { placement: { kind: 'new-tab' } })
    } else {
      f.root.append(f.container)
      f.manager.setActivePane(f.pane.id, { focus: requested })
      expect(f.manager.getActivePane()?.id).toBe(f.pane.id)
      expect(f.onActivePaneChange).toHaveBeenCalledTimes(1)
    }
  }

  it.each(['menu', 'dialog', 'alertdialog', 'listbox'])('preserves a visible %s', (role) => {
    const f = fixture()
    const popup = overlay(role)
    focus(f)
    expect(document.activeElement).toBe(popup)
    expect(f.pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('focuses a terminal hosted inside a dialog', () => {
    const f = fixture()
    overlay('dialog').append(f.root)
    focus(f)
    expect(document.activeElement).toBe(f.textarea)
  })

  it('preserves a nested popup over a dialog-hosted terminal', () => {
    const f = fixture()
    const dialog = overlay('dialog')
    dialog.append(f.root)
    const popup = overlay('menu')
    dialog.append(popup)
    popup.focus()
    focus(f)
    expect(document.activeElement).toBe(popup)
  })

  it('allows focus with only persistent sidebar chrome', () => {
    const f = fixture()
    overlay('listbox').setAttribute('data-worktree-sidebar', '')
    focus(f)
    expect(document.activeElement).toBe(f.textarea)
  })

  it('preserves the focused list during arrow navigation', () => {
    const f = fixture()
    const sidebar = overlay('listbox')
    sidebar.setAttribute('data-worktree-sidebar', '')
    sidebar.setAttribute('data-keyboard-navigation', '')
    focus(f)
    expect(document.activeElement).toBe(sidebar)
    expect(f.pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('ignores a navigation marker on a list that no longer owns focus', () => {
    const f = fixture()
    const sidebar = overlay('listbox')
    sidebar.setAttribute('data-worktree-sidebar', '')
    sidebar.setAttribute('data-keyboard-navigation', '')
    sidebar.blur()
    focus(f)
    expect(document.activeElement).toBe(f.textarea)
  })

  it('allows focus after the overlay closes', () => {
    const f = fixture()
    overlay('menu').style.display = 'none'
    focus(f)
    expect(document.activeElement).toBe(f.textarea)
  })

  it('preserves a popup nested inside sidebar chrome', () => {
    const f = fixture()
    const sidebar = overlay('listbox')
    sidebar.setAttribute('data-worktree-sidebar', '')
    const popup = overlay('menu')
    sidebar.append(popup)
    popup.focus()
    focus(f)
    expect(document.activeElement).toBe(popup)
  })

  it('lands on the chat covering the pane, never its hidden terminal', () => {
    const f = fixture()
    f.root.append(f.container)
    const cover = coverPane(f)
    focus(f)
    expect(document.activeElement).toBe(cover)
    expect(f.pane.terminal.focus).not.toHaveBeenCalled()
  })

  it('honors an explicit no-focus request', () => {
    const f = fixture()
    focus(f, false)
    expect(f.pane.terminal.focus).not.toHaveBeenCalled()
  })
})

it('keeps focus that is already inside the chat covering the pane', () => {
  const f = fixture()
  f.root.append(f.container)
  const composer = document.createElement('button')
  coverPane(f).append(composer)
  composer.focus()
  focusPanePreservingOverlays(f.pane)
  expect(document.activeElement).toBe(composer)
  expect(f.pane.terminal.focus).not.toHaveBeenCalled()
})
