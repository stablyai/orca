// @vitest-environment happy-dom

import React from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HttpLinkDestinationsModule from '@/lib/http-link-destinations'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { GlobalExternalLinkContextMenu } from './use-global-external-link-context-menu'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    DropdownMenu: passthrough,
    DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
      React_.createElement('div', { role: 'menu' }, children),
    DropdownMenuSub: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuTrigger: () => null,
    DropdownMenuItem: ({ onSelect, children }: ItemProps) =>
      React_.createElement('button', { role: 'menuitem', onClick: onSelect }, children)
  }
})
vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{browser\}\}/g, options?.browser ?? '{{browser}}')
  )
}))
const storeState = vi.hoisted(() => ({
  activeWorktreeId: 'wt-1',
  settings: null,
  installedBrowsers: [
    { id: 'com.google.Chrome', name: 'Google Chrome' },
    { id: 'com.apple.Safari', name: 'Safari' }
  ]
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState }
  )
}))
const resolveNativeChatHttpLinkRouting = vi.hoisted(() => vi.fn())
vi.mock('@/components/native-chat/native-chat-link-target-actions', () => ({
  resolveNativeChatHttpLinkRouting
}))
const openRoutedHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http-link-destinations', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpLinkDestinationsModule>()
  openRoutedHttpLink.mockImplementation(actual.openRoutedHttpLink)
  return { ...actual, openRoutedHttpLink }
})

const writeClipboardText = vi.fn(() => Promise.resolve())
const openUrl = vi.fn(() => Promise.resolve())
const registerLocalhostLabel = vi.fn(() =>
  Promise.resolve({ url: 'http://analytics.orca.localhost:60016/' })
)
const LOCAL_PORT_SCAN: WorkspacePortScanResult = {
  platform: 'darwin',
  scannedAt: 1,
  ports: [
    {
      id: 'tcp:5180',
      kind: 'workspace',
      port: 5180,
      protocol: 'http',
      bindHost: '127.0.0.1',
      connectHost: 'localhost',
      owner: {
        repoId: 'repo-1',
        worktreeId: 'wt-analytics',
        displayName: 'analytics',
        path: '/repo/analytics',
        confidence: 'cwd'
      }
    }
  ]
}

function menuItems(): string[] {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent ?? ''
  )
}

function rightClick(element: Element): void {
  act(() => {
    fireEvent.contextMenu(element, { clientX: 10, clientY: 20 })
  })
}

function renderWithMenu(page: React.ReactNode): ReturnType<typeof render> {
  return render(
    <>
      {page}
      <GlobalExternalLinkContextMenu />
    </>
  )
}

beforeEach(() => {
  writeClipboardText.mockClear()
  openUrl.mockClear()
  registerLocalhostLabel.mockClear()
  openRoutedHttpLink.mockClear()
  resolveNativeChatHttpLinkRouting.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText },
      shell: { openUrl },
      localhostWorktreeLabels: { register: registerLocalhostLabel }
    }
  })
  // A scanned local port the global menu must not borrow for links it cannot attribute.
  registerHttpLinkStoreAccessor(() => ({
    settings: { localhostWorktreeLabelsEnabled: true },
    setActiveWorktree: vi.fn(),
    createBrowserTab: vi.fn(),
    repos: [{ id: 'repo-1', displayName: 'snapstudio' }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-analytics' }] },
    workspacePortScan: { result: LOCAL_PORT_SCAN },
    workspacePortScansByKey: { 'local:all': LOCAL_PORT_SCAN }
  }))
})

afterEach(cleanup)

describe('GlobalExternalLinkContextMenu', () => {
  it('offers only external browsers for an anchor without a known owner', () => {
    const view = renderWithMenu(<a href="https://github.com/o/r/pull/1">PR #1</a>)

    rightClick(view.getByText('PR #1'))

    expect(menuItems()).toEqual(['Open in System Browser', 'Google Chrome', 'Safari', 'Copy Link'])
    fireEvent.click(view.getByText('Copy Link'))
    expect(writeClipboardText).toHaveBeenCalledWith('https://github.com/o/r/pull/1')
  })

  it('opens an unowned localhost link externally without a local worktree label', () => {
    const view = renderWithMenu(<a href="http://localhost:5180/">dev server</a>)

    rightClick(view.getByText('dev server'))
    fireEvent.click(view.getByText('Safari'))

    expect(openUrl).toHaveBeenCalledWith('http://localhost:5180/', 'com.apple.Safari')
    expect(registerLocalhostLabel).not.toHaveBeenCalled()
  })

  it('keeps a remote-owned preview link out of Orca and off local port labels', () => {
    const view = renderWithMenu(
      <a
        href="http://localhost:5180/"
        data-orca-link-owner="runtime:env-1"
        data-orca-link-worktree-id="wt-1"
      >
        remote dev server
      </a>
    )

    rightClick(view.getByText('remote dev server'))
    expect(menuItems()).not.toContain('Open in Orca Browser')
    fireEvent.click(view.getByText('Open in System Browser'))

    expect(openRoutedHttpLink).toHaveBeenCalledWith('http://localhost:5180/', {
      worktreeId: 'wt-1',
      sourceOwner: { kind: 'runtime', runtimeEnvironmentId: 'env-1' },
      forceDestination: 'system'
    })
    expect(openUrl).toHaveBeenCalledWith('http://localhost:5180/')
    expect(registerLocalhostLabel).not.toHaveBeenCalled()
  })

  it('routes a marked control on a background worktree card through that worktree', () => {
    resolveNativeChatHttpLinkRouting.mockReturnValue({
      sourceOwner: { kind: 'local' },
      destinations: { primary: 'system', alternate: 'orca' }
    })
    openRoutedHttpLink.mockImplementationOnce(() => {})
    const view = renderWithMenu(
      <div data-orca-link-worktree-id="wt-2">
        <a
          href="https://github.com/o/r/pull/3"
          data-orca-external-url="https://github.com/o/r/pull/3"
        >
          PR #3
        </a>
      </div>
    )

    rightClick(view.getByText('PR #3'))
    fireEvent.click(view.getByText('Open in Orca Browser'))

    expect(resolveNativeChatHttpLinkRouting).toHaveBeenCalledWith(storeState, 'wt-2')
    expect(openRoutedHttpLink).toHaveBeenCalledWith('https://github.com/o/r/pull/3', {
      worktreeId: 'wt-2',
      sourceOwner: { kind: 'local' },
      forceDestination: 'orca'
    })
  })

  it('shows no menu for a link whose owner is unknown', () => {
    resolveNativeChatHttpLinkRouting.mockReturnValue({
      sourceOwner: { kind: 'unknown' },
      destinations: { primary: 'system' }
    })
    const view = renderWithMenu(
      <>
        <a href="https://example.com/doc" data-orca-link-owner="unknown">
          preview link
        </a>
        <button
          type="button"
          data-orca-link-worktree-id="wt-3"
          data-orca-external-url="https://github.com/o/r/pull/4"
        >
          PR #4
        </button>
      </>
    )

    rightClick(view.getByText('preview link'))
    rightClick(view.getByText('PR #4'))

    expect(menuItems()).toEqual([])
  })

  it('opens the menu for the URL on a marked control', () => {
    const view = renderWithMenu(
      <button type="button" data-orca-external-url="https://github.com/o/r/issues/2">
        Open on GitHub
      </button>
    )

    rightClick(view.getByText('Open on GitHub'))
    fireEvent.click(view.getByText('Copy Link'))

    expect(writeClipboardText).toHaveBeenCalledWith('https://github.com/o/r/issues/2')
  })

  it('offers installed browsers on a task-page row even inside a surface with its own menu', () => {
    const surfaceMenu = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const view = renderWithMenu(
      <div onContextMenuCapture={surfaceMenu}>
        <div role="button" data-orca-external-url="https://linear.app/o/issue/ENG-1">
          <span>ENG-1 Fix login</span>
        </div>
      </div>
    )

    rightClick(view.getByText('ENG-1 Fix login'))

    expect(surfaceMenu).not.toHaveBeenCalled()
    expect(menuItems()).toEqual(expect.arrayContaining(['Google Chrome', 'Safari', 'Copy Link']))
  })

  it('leaves an event another surface already handled alone', () => {
    const view = renderWithMenu(
      <div onContextMenu={(event) => event.preventDefault()}>
        <a href="https://github.com/o/r/pull/1">PR #1</a>
      </div>
    )

    rightClick(view.getByText('PR #1'))

    expect(menuItems()).toEqual([])
  })

  it.each(['mailto:someone@example.com', 'docs/readme.md'])('ignores a %s href', (href) => {
    const view = renderWithMenu(<a href={href}>link</a>)

    rightClick(view.getByText('link'))

    expect(menuItems()).toEqual([])
  })
})
