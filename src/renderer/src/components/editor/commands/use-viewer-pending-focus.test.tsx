// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { useViewerPendingFocus } from './use-viewer-pending-focus'

const NOW = 1_700_000_000_000
const pane = { file: { id: 'file-pdf', worktreeId: 'wt-1' }, viewStateId: 'view-1' }

type SetupOptions = {
  viewStateId?: string
  focusAfterOpen?: (row: HTMLElement) => void
  expiresInMs?: number
  mountBeforeOpen?: boolean
}

function setup({
  viewStateId = pane.viewStateId,
  focusAfterOpen,
  expiresInMs = 60_000,
  mountBeforeOpen = false
}: SetupOptions = {}) {
  // The explorer row that opened the file holds focus when the open asks for it.
  const row = document.createElement('button')
  const viewer = document.createElement('div')
  viewer.tabIndex = -1
  document.body.append(row, viewer)
  row.focus()
  const mount = (): void => {
    renderHook(() => useViewerPendingFocus(pane, { current: viewer }))
  }
  if (mountBeforeOpen) {
    mount()
  }
  act(() => {
    useAppStore.setState({
      pendingEditorFocusRequest: {
        fileId: pane.file.id,
        worktreeId: pane.file.worktreeId,
        viewStateId,
        focusedAtOpen: new WeakRef(row),
        expiresAt: NOW + expiresInMs,
        token: 7
      }
    })
  })
  focusAfterOpen?.(row)
  if (!mountBeforeOpen) {
    mount()
  }
  return { row, viewer }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  useAppStore.setState({ pendingEditorFocusRequest: null })
  document.body.innerHTML = ''
})

describe('useViewerPendingFocus', () => {
  it('moves focus from the opener into the viewer its open was meant for', () => {
    const { viewer } = setup()
    expect(document.activeElement).toBe(viewer)
    expect(useAppStore.getState().pendingEditorFocusRequest).toBeNull()
  })

  it('takes focus when the request arrives after the viewer is already mounted', () => {
    const { viewer } = setup({ mountBeforeOpen: true })
    expect(document.activeElement).toBe(viewer)
    expect(useAppStore.getState().pendingEditorFocusRequest).toBeNull()
  })

  it('leaves a request for another split pane alone', () => {
    const { row } = setup({ viewStateId: 'view-2' })
    expect(document.activeElement).toBe(row)
    expect(useAppStore.getState().pendingEditorFocusRequest?.token).toBe(7)
  })

  it('drops an expired request without taking focus', () => {
    const { row } = setup({ expiresInMs: -1 })
    expect(document.activeElement).toBe(row)
    expect(useAppStore.getState().pendingEditorFocusRequest).toBeNull()
  })

  it('drops the request without stealing focus the user moved elsewhere during a slow load', () => {
    const terminal = document.createElement('textarea')
    setup({
      focusAfterOpen: (row) => {
        row.after(terminal)
        terminal.focus()
      }
    })
    expect(document.activeElement).toBe(terminal)
    expect(useAppStore.getState().pendingEditorFocusRequest).toBeNull()
  })
})
