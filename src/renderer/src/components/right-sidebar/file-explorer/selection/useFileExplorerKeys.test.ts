// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { createFileExplorerRowProjection } from '../tree/file-explorer-row-projection'
import { useFileExplorerKeys } from './useFileExplorerKeys'

const initialStoreState = useAppStore.getState()
const originalUserAgent = navigator.userAgent

function setUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value,
    configurable: true
  })
}

function buildWorkspaceDom(): {
  shell: HTMLDivElement
  viewport: HTMLDivElement
  rowButton: HTMLButtonElement
  filterInput: HTMLInputElement
  chatPrompt: HTMLDivElement
  terminalTextarea: HTMLTextAreaElement
  editorTextarea: HTMLTextAreaElement
} {
  const shell = document.createElement('div')
  shell.setAttribute('data-orca-explorer-shell', '')
  const filterWrap = document.createElement('div')
  filterWrap.setAttribute('data-ignore-file-explorer-keys', 'true')
  const filterInput = document.createElement('input')
  filterWrap.appendChild(filterInput)
  const viewport = document.createElement('div')
  viewport.tabIndex = -1
  const rowButton = document.createElement('button')
  viewport.appendChild(rowButton)
  shell.append(filterWrap, viewport)

  const chatRoot = document.createElement('div')
  chatRoot.setAttribute('data-native-chat-root', '')
  const chatPrompt = document.createElement('div')
  chatPrompt.setAttribute('data-native-chat-prompt-editor', '')
  chatPrompt.contentEditable = 'true'
  chatRoot.appendChild(chatPrompt)

  const terminalTextarea = document.createElement('textarea')
  terminalTextarea.className = 'xterm-helper-textarea'

  const editorTextarea = document.createElement('textarea')
  editorTextarea.className = 'inputarea'

  document.body.append(shell, chatRoot, terminalTextarea, editorTextarea)
  return {
    shell,
    viewport,
    rowButton,
    filterInput,
    chatPrompt,
    terminalTextarea,
    editorTextarea
  }
}

function renderExplorerKeys(
  container: HTMLDivElement,
  overrides: Partial<Parameters<typeof useFileExplorerKeys>[0]> = {}
) {
  return renderHook(
    (props: Partial<Parameters<typeof useFileExplorerKeys>[0]>) =>
      useFileExplorerKeys({
        containerRef: { current: container },
        rowProjection: createFileExplorerRowProjection([]),
        expandedPaths: new Set(),
        canToggleDirectories: true,
        inlineInput: null,
        selectedPaths: new Set(),
        selectedNode: null,
        activateNode: () => {},
        moveSelection: () => {},
        toggleDir: () => {},
        startRename: () => {},
        requestDelete: () => {},
        requestDeleteAll: () => {},
        scrollToIndex: () => {},
        activeWorktreeId: 'wt-1',
        pathOwner: 'unresolved',
        ...props
      }),
    { initialProps: overrides }
  )
}

function dispatchKey(target: EventTarget, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init
  })
  target.dispatchEvent(event)
  return event
}

describe('useFileExplorerKeys dotfiles shortcut', () => {
  beforeEach(() => {
    useAppStore.setState(initialStoreState, true)
    useAppStore.setState({
      settings: {
        ...(initialStoreState.settings ?? getDefaultSettings('/fixture-home')),
        terminalShortcutPolicy: 'orca-first'
      },
      rightSidebarOpen: true,
      rightSidebarTab: 'explorer',
      rightSidebarExplorerView: 'files',
      activeWorktreeId: 'wt-1',
      showDotfilesByWorktree: {},
      keybindings: {}
    })
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    cleanup()
    document.body.innerHTML = ''
    setUserAgent(originalUserAgent)
    vi.restoreAllMocks()
  })

  it('toggles per-worktree dotfiles only when the explorer is focused and swallows repeats', () => {
    const { shell, viewport, rowButton, chatPrompt, terminalTextarea, editorTextarea } =
      buildWorkspaceDom()
    const { unmount } = renderExplorerKeys(shell)

    // Ignores chatbox, terminal, and editor focus outside the explorer.
    for (const outsideTarget of [chatPrompt, terminalTextarea, editorTextarea]) {
      outsideTarget.focus()
      const outsideEvent = dispatchKey(outsideTarget, {
        key: '.',
        code: 'Period',
        metaKey: true,
        shiftKey: true
      })
      expect(outsideEvent.defaultPrevented).toBe(false)
      expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()
    }

    // Works when a row inside the explorer is focused.
    rowButton.focus()
    const fromRow = dispatchKey(rowButton, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(fromRow.defaultPrevented).toBe(true)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBe(false)

    // Swallows held repeats without toggling again.
    const repeated = dispatchKey(rowButton, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true,
      repeat: true
    })
    expect(repeated.defaultPrevented).toBe(true)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBe(false)

    // Works when the explorer viewport background itself is focused.
    viewport.focus()
    const fromViewport = dispatchKey(viewport, {
      key: '>',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(fromViewport.defaultPrevented).toBe(true)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()
    unmount()
  })

  it('uses Ctrl+Shift+. on Linux/Windows and respects custom rebindings when explorer is focused', () => {
    setUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    const { shell, rowButton } = buildWorkspaceDom()
    const { unmount } = renderExplorerKeys(shell)
    rowButton.focus()

    dispatchKey(rowButton, { key: '>', code: 'Period', ctrlKey: true, shiftKey: true })
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBe(false)

    act(() => {
      useAppStore.setState({ keybindings: { 'fileExplorer.toggleDotfiles': ['Mod+H'] } })
    })
    dispatchKey(rowButton, { key: '>', code: 'Period', ctrlKey: true, shiftKey: true })
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBe(false)

    dispatchKey(rowButton, { key: 'h', code: 'KeyH', ctrlKey: true })
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()
    unmount()
  })

  it('ignores filter input, inline input, and hidden explorer states', () => {
    const { shell, rowButton, filterInput } = buildWorkspaceDom()
    const { rerender, unmount } = renderExplorerKeys(shell)

    filterInput.focus()
    const inputEvent = dispatchKey(filterInput, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(inputEvent.defaultPrevented).toBe(false)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()

    rowButton.focus()
    rerender({
      inlineInput: { type: 'file', parentPath: '/repo', depth: 0 }
    })
    const inlineEvent = dispatchKey(rowButton, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(inlineEvent.defaultPrevented).toBe(false)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()

    rerender({ inlineInput: null })
    rowButton.focus()
    act(() => {
      useAppStore.setState({ rightSidebarExplorerView: 'search' })
    })
    const searchViewEvent = dispatchKey(rowButton, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(searchViewEvent.defaultPrevented).toBe(false)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()

    act(() => {
      useAppStore.setState({ rightSidebarExplorerView: 'files', rightSidebarOpen: false })
    })
    const closedSidebarEvent = dispatchKey(rowButton, {
      key: '.',
      code: 'Period',
      metaKey: true,
      shiftKey: true
    })
    expect(closedSidebarEvent.defaultPrevented).toBe(false)
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()
    unmount()
  })

  it('moves focus to the explorer viewport if hiding dotfiles unmounts a focused explorer row', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })

    const { shell, viewport, rowButton } = buildWorkspaceDom()
    const { unmount } = renderExplorerKeys(shell)
    rowButton.focus()

    dispatchKey(rowButton, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBe(false)

    rowButton.remove()
    document.body.focus()
    for (const cb of rafCallbacks) {
      cb(0)
    }

    expect(document.activeElement).toBe(viewport)
    dispatchKey(viewport, { key: '.', code: 'Period', metaKey: true, shiftKey: true })
    expect(useAppStore.getState().showDotfilesByWorktree['wt-1']).toBeUndefined()
    unmount()
  })
})
