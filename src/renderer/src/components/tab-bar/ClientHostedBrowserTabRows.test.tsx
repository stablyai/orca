// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { clearClientHostedBrowserRowSelection } from '@/lib/pane-manager/client-hosted-browser-row-state'
import type { ClientHostedBrowserRow } from '../../../../shared/client-hosted-browser-rows'
import { closeClientHostedBrowserRow } from '../../runtime/client-hosted-browser-row-close'
import ClientHostedBrowserTabRows from './ClientHostedBrowserTabRows'
import { getTabRootStateClasses } from './drop-indicator'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../../runtime/client-hosted-browser-row-close', () => ({
  closeClientHostedBrowserRow: vi.fn()
}))
vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { focusGroup: () => void }) => unknown) =>
    selector({ focusGroup: () => {} })
}))

const ROW: ClientHostedBrowserRow = {
  browserPageId: 'page-1',
  worktreeId: 'wt-1',
  url: 'https://example.test/page-1',
  title: 'Marker',
  loading: false,
  browserHostClientId: 'host-a',
  hostDeviceName: 'Studio',
  hostAbsent: false
}

const mountedRoots: Root[] = []
let mountedRoot: Root | null = null

function rowsTree(groupActiveTabId: string | null): React.JSX.Element {
  return (
    <TooltipProvider>
      <ClientHostedBrowserTabRows
        rows={[ROW]}
        worktreeId="wt-1"
        groupId="group-1"
        groupActiveTabId={groupActiveTabId}
        includeTopTabBorder
      />
    </TooltipProvider>
  )
}

function renderRows(groupActiveTabId: string | null = null): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  mountedRoot = root
  act(() => {
    root.render(rowsTree(groupActiveTabId))
  })
  return container
}

function rerenderRows(groupActiveTabId: string | null): void {
  act(() => {
    mountedRoot?.render(rowsTree(groupActiveTabId))
  })
}

function rowElement(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-client-hosted-browser-row-id="page-1"]')
  if (!row) {
    throw new Error('row not found')
  }
  return row
}

function isRowActive(container: HTMLElement): boolean {
  return rowElement(container).className.includes(getTabRootStateClasses(true))
}

function clickRow(container: HTMLElement): void {
  act(() => {
    rowElement(container).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  })
}

function clickClose(container: HTMLElement): void {
  const button = container.querySelector('button[aria-label="Close hosted page"]')
  if (!button) {
    throw new Error('close button not found')
  }
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

afterEach(() => {
  mountedRoots.splice(0).forEach((root) => act(() => root.unmount()))
  mountedRoot = null
  clearClientHostedBrowserRowSelection()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

describe('ClientHostedBrowserTabRows selection', () => {
  it('underlines the row the user picked', () => {
    const container = renderRows('tab-a')

    clickRow(container)

    expect(isRowActive(container)).toBe(true)
  })

  /**
   * The other half of the strip paints itself from the group's `activeTabId`, which a keyboard
   * switch or the command palette moves without ever touching this row. Holding the underline
   * through that move is how the strip ends up showing two active tabs.
   */
  it('drops the underline once the group activates a real tab', () => {
    const container = renderRows('tab-a')
    clickRow(container)

    rerenderRows('tab-b')

    expect(isRowActive(container)).toBe(false)
  })
})

describe('ClientHostedBrowserTabRows close', () => {
  // Why a toast and not just the console: this row is the only way to close a page this host does
  // not render, and a refused close leaves it sitting there looking like the click missed.
  it('tells the user when the close is refused', async () => {
    vi.mocked(closeClientHostedBrowserRow).mockRejectedValue(new Error('runtime rpc timed out'))
    const container = renderRows()

    clickClose(container)
    await act(async () => {})

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't close this page. The device hosting it may be busy — try again."
    )
  })

  it('stays quiet when the close lands', async () => {
    vi.mocked(closeClientHostedBrowserRow).mockResolvedValue(undefined)
    const container = renderRows()

    clickClose(container)
    await act(async () => {})

    expect(closeClientHostedBrowserRow).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      browserPageId: 'page-1'
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
