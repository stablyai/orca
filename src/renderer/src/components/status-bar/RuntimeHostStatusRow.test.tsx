// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: (event: { preventDefault: () => void }) => void
  }) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onSelect?.({ preventDefault: () => undefined })}
    >
      {children}
    </button>
  ),
  DropdownMenuSub: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-sub">{children}</div>
  ),
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-sub-content">{children}</div>
  ),
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => (
    <div data-slot="dropdown-menu-sub-trigger">{children}</div>
  )
}))

afterEach(cleanup)

describe('RuntimeHostStatusRow', () => {
  it('renders reconnecting diagnostics for remote hosts', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow label="Dev Box" state="reconnecting" detail="Attempt 3" />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Reconnecting')
    expect(markup).toContain('Attempt 3')
  })

  it('renders disconnected hosts with a connect action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="disconnected"
        detail="Last closed: 1006"
        onConnect={async () => {}}
      />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Remote Server')
    expect(markup).toContain('Disconnected')
    expect(markup).toContain('Last closed: 1006')
    expect(markup).toContain('Connect')
  })

  it('names the closed workspace window while keeping the disconnect action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="workspace-window-closed"
        onConnect={async () => {}}
        onDisconnect={async () => {}}
      />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Workspace window closed')
    expect(markup).toContain('Disconnect')
    expect(markup).not.toContain('>Connect</button>')
    // The host is still reachable — the row must not read as a lost connection.
    expect(markup).not.toContain('Disconnected')
    // Why: proves the row routes the action to onDisconnect — with only a connect
    // handler there is nothing to offer, so no button renders.
    expect(
      renderToStaticMarkup(
        <RuntimeHostStatusRow
          label="Dev Box"
          state="workspace-window-closed"
          onConnect={async () => {}}
        />
      )
    ).not.toContain('<button')
  })

  it('renders connected hosts with a disconnect action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeHostStatusRow label="Dev Box" state="connected" onDisconnect={async () => {}} />
    )

    expect(markup).toContain('Dev Box')
    expect(markup).toContain('Connected')
    expect(markup).toContain('Disconnect')
  })

  it('renders transport-up runtime-unavailable hosts without implying process death', () => {
    const { container } = render(
      <RuntimeHostStatusRow
        label="OpenClaw"
        state="runtime-unavailable"
        detail="status.get refused"
        onDisconnect={async () => {}}
      />
    )

    expect(container.textContent).toContain('Orca unavailable')
    expect(container.textContent).toContain('SSH transport is connected')
    expect(container.textContent).toContain('may still be running')
    expect(container.textContent).toContain('Disconnect')
    expect(container.textContent).not.toContain('exited')
  })

  it('keeps healthy rows free of a submenu trigger', () => {
    const { container } = render(<RuntimeHostStatusRow label="Dev Box" state="connected" />)

    expect(container.querySelector('[data-slot="dropdown-menu-sub-trigger"]')).toBeNull()
  })

  it('renders failing rows as submenu triggers', () => {
    const { container } = render(
      <RuntimeHostStatusRow label="Dev Box" state="disconnected" detail="Connection refused" />
    )

    const trigger = container.querySelector('[data-slot="dropdown-menu-sub-trigger"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.querySelector('button')).toBeNull()
  })

  it('keeps the row action invokable for failing hosts', async () => {
    const onConnect = vi.fn(async () => {})
    render(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="disconnected"
        detail="Connection refused"
        onConnect={onConnect}
      />
    )

    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0])

    await waitFor(() => expect(onConnect).toHaveBeenCalledOnce())
  })

  it('renders a long raw error in full inside the submenu', () => {
    const longError = `Invalid remote endpoint: ${'wss://relay.example.test/path/'.repeat(8)}`
    const { container } = render(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="disconnected"
        detail={longError}
        diagnostics={{
          state: 'closed',
          pendingRequestCount: 0,
          subscriptionCount: 0,
          reconnectAttempt: 3,
          lastConnectedAt: null,
          lastClose: null,
          lastError: longError
        }}
      />
    )

    const submenu = container.querySelector('[data-slot="dropdown-menu-sub-content"]')
    expect(submenu).not.toBeNull()
    expect(submenu?.textContent).toContain(longError)
  })

  it('shows the existing connection diagnostics in the submenu', () => {
    const { container } = render(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="reconnecting"
        detail="Connection refused"
        diagnostics={{
          state: 'reconnecting',
          pendingRequestCount: 0,
          subscriptionCount: 0,
          reconnectAttempt: 2,
          lastConnectedAt: Date.now() - 60_000,
          lastClose: null,
          lastError: 'Connection refused'
        }}
      />
    )

    const submenu = container.querySelector('[data-slot="dropdown-menu-sub-content"]')
    expect(submenu?.textContent).toContain('Last connected')
    expect(submenu?.textContent).toContain('Attempt 3')
  })
})
