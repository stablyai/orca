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
  storeState,
  writeClipboardTextMock
} = vi.hoisted(() => {
  const settings: { openLinksInApp: boolean; openLinksInAppModifierInverts?: boolean } = {
    openLinksInApp: true
  }
  const state = {
    settings,
    activeWorktreeId: null,
    createBrowserTab: vi.fn(),
    setRemoteBrowserPageHandle: vi.fn(),
    replaceWorkspacePortScans: vi.fn(),
    setWorkspacePortScanRefreshing: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    runtimeEnvironments: [
      {
        id: 'env-1',
        name: 'vps',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: 'runtime-1',
        preferredEndpointId: 'ws-primary',
        endpoints: [
          {
            id: 'ws-primary',
            kind: 'websocket' as const,
            label: 'Tailscale',
            endpoint: 'ws://100.64.1.20:6768'
          }
        ]
      }
    ],
    workspacePortScansByKey: {}
  }
  return {
    activateAndRevealWorktreeMock: vi.fn(),
    createBrowserTabMock: state.createBrowserTab,
    openUrlMock: vi.fn(),
    recordFeatureInteractionMock: state.recordFeatureInteraction,
    setRemoteBrowserPageHandleMock: state.setRemoteBrowserPageHandle,
    storeState: state,
    writeClipboardTextMock: vi.fn()
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
  getExecutionHostIdForWorktree: () => 'local'
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

const STOCK_SETTINGS = storeState.settings

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
        writeClipboardText: writeClipboardTextMock
      }
    }
    openUrlMock.mockResolvedValue(undefined)
    createBrowserTabMock.mockReset()
    openUrlMock.mockClear()
    recordFeatureInteractionMock.mockClear()
    setRemoteBrowserPageHandleMock.mockClear()
    activateAndRevealWorktreeMock.mockClear()
    writeClipboardTextMock.mockClear()
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

describe('status bar port row address attribution', () => {
  let container: HTMLDivElement
  let root: Root

  const remoteWildcardPort: WorkspacePort = {
    kind: 'workspace',
    id: 'environment:env-1:all:0.0.0.0:5173',
    hostScanKey: 'environment:env-1:all',
    bindHost: '0.0.0.0',
    connectHost: 'localhost',
    port: 5173,
    protocol: 'http',
    processName: 'node',
    owner: {
      worktreeId: 'repo-1:feature',
      repoId: 'repo-1',
      displayName: 'feature',
      path: '/srv/work/feature',
      confidence: 'cwd'
    }
  }

  beforeEach(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64)',
      configurable: true
    })
    ;(window as unknown as { api: unknown }).api = {
      shell: { openUrl: openUrlMock },
      ui: { writeClipboardText: writeClipboardTextMock }
    }
    writeClipboardTextMock.mockClear()
    openUrlMock.mockClear()
    openUrlMock.mockResolvedValue(undefined)
    createBrowserTabMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    storeState.settings = STOCK_SETTINGS
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  function renderRow(port: WorkspacePort): void {
    act(() => {
      root.render(<PortRow port={port} activeWorktreeId="repo-1:feature" />)
    })
  }

  function copyButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label^="Copy "]')
    if (!button) {
      throw new Error('expected Copy button')
    }
    return button
  }

  function openButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Open in Browser"]'
    )
    if (!button) {
      throw new Error('expected Open in Browser button')
    }
    return button
  }

  it('shows and copies the reachable address for a remote wildcard-bound port', () => {
    renderRow(remoteWildcardPort)
    expect(container.textContent).toContain('100.64.1.20:5173')
    expect(container.textContent).not.toContain('localhost:5173')
    act(() => {
      copyButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 1 }))
    })
    expect(writeClipboardTextMock).toHaveBeenCalledWith('100.64.1.20:5173')
  })

  it('keeps the OS-derived address for a remote loopback-bound port', () => {
    renderRow({ ...remoteWildcardPort, bindHost: '127.0.0.1', connectHost: '127.0.0.1' })
    expect(container.textContent).toContain('127.0.0.1:5173')
    // No address reaches a loopback listener from another machine, so the tooltip must
    // not advertise a modifier that would silently fall through to the in-app browser.
    expect(container.textContent).not.toContain('for system browser')
  })

  it('still reaches the system browser on a remote port when the modifier is inverted', async () => {
    // Regression: "invert the modifier" means "the other destination", and on a remote
    // port the other destination is never Orca — a plain click already lands there. The
    // earlier build sent the modifier to Orca anyway, so this cohort could never reach
    // the system browser while the tooltip advertised a gesture that did nothing.
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }
    renderRow(remoteWildcardPort)
    expect(container.textContent).toContain('Shift+Ctrl+click for system browser')

    await act(async () => {
      openButton().dispatchEvent(
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

    expect(openUrlMock).toHaveBeenCalledWith('http://100.64.1.20:5173')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('drops the hint on an unreachable remote port even for an inverting user', () => {
    storeState.settings = { openLinksInApp: false, openLinksInAppModifierInverts: true }
    renderRow({ ...remoteWildcardPort, bindHost: '127.0.0.1', connectHost: '127.0.0.1' })
    expect(container.textContent).not.toContain('for system browser')
    expect(container.textContent).not.toContain('to open in Orca')
  })

  it('does not stamp a local row in the merged view with the remote host', () => {
    // Regression: the popover renders the merged all-hosts scan. Falling back to the
    // active (remote) workspace's host made a local 0.0.0.0 listener read as the remote
    // machine's address, pointing at whatever that host runs on the same port.
    renderRow({
      ...remoteWildcardPort,
      id: 'local:all:0.0.0.0:7000',
      hostScanKey: 'local:all',
      port: 7000
    })
    expect(container.textContent).toContain('localhost:7000')
    expect(container.textContent).not.toContain('100.64.1.20')
  })
})
