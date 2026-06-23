// @vitest-environment happy-dom

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '../store'
import { focusTerminalTabSurface } from '../lib/focus-terminal-tab-surface'
import { ORCA_BROWSER_FOCUS_REQUEST_EVENT } from '../components/browser-pane/browser-focus'
import { useModalReturnFocus } from './useModalReturnFocus'

vi.mock('../lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestCaptureReturnFocus: (() => void) | null = null
let latestSkipReturnFocus: (() => void) | null = null
let nextAnimationFrameId = 1
let animationFrames = new Map<number, FrameRequestCallback>()

function installAnimationFrameStubs(): void {
  nextAnimationFrameId = 1
  animationFrames = new Map()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextAnimationFrameId
    nextAnimationFrameId += 1
    animationFrames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    animationFrames.delete(id)
  })
}

function flushAnimationFrames(): void {
  for (let i = 0; i < 10 && animationFrames.size > 0; i += 1) {
    const pending = Array.from(animationFrames.values())
    animationFrames.clear()
    for (const callback of pending) {
      callback(0)
    }
  }
}

function Probe({ visible }: { visible: boolean }): null {
  const { captureReturnFocus, skipReturnFocus } = useModalReturnFocus(visible)
  useEffect(() => {
    latestCaptureReturnFocus = captureReturnFocus
    latestSkipReturnFocus = skipReturnFocus
  }, [captureReturnFocus, skipReturnFocus])
  return null
}

async function renderProbe(visible: boolean): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe visible={visible} />)
  })
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  latestCaptureReturnFocus = null
  latestSkipReturnFocus = null
  document.body.innerHTML = ''
  useAppStore.setState({
    activeWorktreeId: null,
    activeTabType: 'terminal',
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeBrowserTabId: null,
    browserTabsByWorktree: {},
    terminalLayoutsByTabId: {}
  })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('useModalReturnFocus', () => {
  it('returns focus to the editor even when a terminal textarea is mounted first', async () => {
    installAnimationFrameStubs()
    useAppStore.setState({ activeWorktreeId: 'wt-1', activeTabType: 'editor' })
    const terminalTextarea = document.createElement('textarea')
    terminalTextarea.className = 'xterm-helper-textarea'
    document.body.append(terminalTextarea)
    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    const editorTextarea = document.createElement('textarea')
    monaco.append(editorTextarea)
    document.body.append(monaco)

    await renderProbe(true)
    await renderProbe(false)
    flushAnimationFrames()

    expect(document.activeElement).toBe(editorTextarea)
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
  })

  it('returns focus to the captured editor when multiple editors are mounted', async () => {
    installAnimationFrameStubs()
    useAppStore.setState({ activeWorktreeId: 'wt-1', activeTabType: 'editor' })
    const firstEditor = document.createElement('textarea')
    const firstMonaco = document.createElement('div')
    firstMonaco.className = 'monaco-editor'
    firstMonaco.append(firstEditor)
    document.body.append(firstMonaco)
    const secondEditor = document.createElement('textarea')
    const secondMonaco = document.createElement('div')
    secondMonaco.className = 'monaco-editor'
    secondMonaco.append(secondEditor)
    document.body.append(secondMonaco)

    await renderProbe(false)
    secondEditor.focus()
    latestCaptureReturnFocus?.()
    await renderProbe(true)
    firstEditor.focus()
    await renderProbe(false)
    flushAnimationFrames()

    expect(document.activeElement).toBe(secondEditor)
  })

  it('captures browser address-bar focus before dialog autofocus moves focus', async () => {
    installAnimationFrameStubs()
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'browser',
      activeBrowserTabId: 'browser-1',
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    })
    const addressBar = document.createElement('input')
    addressBar.dataset.orcaBrowserAddressBar = 'true'
    document.body.append(addressBar)
    const dialogInput = document.createElement('input')
    document.body.append(dialogInput)
    const focusRequests: unknown[] = []
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, (event) => {
      focusRequests.push((event as CustomEvent).detail)
    })

    await renderProbe(false)
    addressBar.focus()
    latestCaptureReturnFocus?.()
    await renderProbe(true)
    dialogInput.focus()
    await renderProbe(false)

    expect(focusRequests).toEqual([{ pageId: 'page-1', target: 'address-bar' }])
  })

  it('uses the scoped terminal focus helper for terminal surfaces', async () => {
    installAnimationFrameStubs()
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'terminal-global',
      activeTabIdByWorktree: { 'wt-1': 'terminal-1' },
      terminalLayoutsByTabId: {
        'terminal-1': { root: null, activeLeafId: 'leaf-1', expandedLeafId: null }
      }
    })

    await renderProbe(true)
    await renderProbe(false)

    expect(focusTerminalTabSurface).toHaveBeenCalledWith('terminal-1', 'leaf-1')
  })

  it('skips return focus when the close action already moved focus', async () => {
    installAnimationFrameStubs()
    useAppStore.setState({ activeWorktreeId: 'wt-1', activeTabType: 'editor' })
    const monaco = document.createElement('div')
    monaco.className = 'monaco-editor'
    const editorTextarea = document.createElement('textarea')
    monaco.append(editorTextarea)
    document.body.append(monaco)

    await renderProbe(true)
    latestSkipReturnFocus?.()
    await renderProbe(false)
    flushAnimationFrames()

    expect(document.activeElement).not.toBe(editorTextarea)
    expect(focusTerminalTabSurface).not.toHaveBeenCalled()
  })
})
