// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

const {
  activateAndRevealWorktreeMock,
  createBrowserTabMock,
  openUrlMock,
  recordFeatureInteractionMock,
  setRemoteBrowserPageHandleMock,
  storeState
} = vi.hoisted(() => {
  const state = {
    settings: { openLinksInApp: true },
    createBrowserTab: vi.fn(),
    setRemoteBrowserPageHandle: vi.fn(),
    setWorkspacePortScan: vi.fn(),
    setWorkspacePortScanForKey: vi.fn(),
    setWorkspacePortScanRefreshing: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    workspacePortScansByKey: {}
  }
  return {
    activateAndRevealWorktreeMock: vi.fn(),
    createBrowserTabMock: state.createBrowserTab,
    openUrlMock: vi.fn(),
    recordFeatureInteractionMock: state.recordFeatureInteraction,
    setRemoteBrowserPageHandleMock: state.setRemoteBrowserPageHandle,
    storeState: state
  }
})

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
  return { useAppStore }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: activateAndRevealWorktreeMock
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => null
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: () => ({ kind: 'local' }),
  callRuntimeRpc: vi.fn(),
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code?: string
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

import { PortRow } from './ports-status-popover-rows'

const externalPort: WorkspacePort = {
  id: '127.0.0.1:63468:1234',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 63468,
  pid: 1234,
  processName: 'node',
  protocol: 'http',
  kind: 'external'
}

describe('status bar port row open routing', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: {
        openUrl: openUrlMock
      },
      ui: {
        writeClipboardText: vi.fn()
      }
    }
    openUrlMock.mockResolvedValue(undefined)
    createBrowserTabMock.mockReset()
    openUrlMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    setRemoteBrowserPageHandleMock.mockClear()
    activateAndRevealWorktreeMock.mockClear()
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderPortRow(): HTMLButtonElement {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(<PortRow port={externalPort} activeWorktreeId={null} external />)
    })
    const openButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in Browser"]'
    )
    if (!openButton) {
      throw new Error('expected Open in Browser button')
    }
    expect(container.textContent).toContain('Open in Browser. Shift+Ctrl+click for system browser')
    return openButton
  }

  it('keeps the open button enabled and forwards Shift+Ctrl-click to system-browser routing', async () => {
    const openButton = renderPortRow()

    expect(openButton.disabled).toBe(false)

    await act(async () => {
      openButton.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          detail: 1,
          shiftKey: true
        })
      )
      await Promise.resolve()
    })

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('ports')
    expect(openUrlMock).toHaveBeenCalledWith('http://127.0.0.1:63468')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(activateAndRevealWorktreeMock).not.toHaveBeenCalled()
  })

  it('keeps no-pointer activations on the saved link-routing setting', async () => {
    const openButton = renderPortRow()

    expect(openButton.disabled).toBe(false)

    await act(async () => {
      openButton.dispatchEvent(
        new window.MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          shiftKey: true
        })
      )
      await Promise.resolve()
    })

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('ports')
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })
})
