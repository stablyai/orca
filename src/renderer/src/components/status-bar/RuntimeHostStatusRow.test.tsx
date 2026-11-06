// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeHostStatusRow } from './RuntimeHostStatusRow'
import { runtimeHostBlockedCopy } from './remote-host-connection-status'

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

  it('sends a replaced server to its settings instead of a futile Connect (#37766)', () => {
    const onConnect = vi.fn(async () => {})
    const onRecover = vi.fn()
    render(
      <RuntimeHostStatusRow
        label="Dev Box"
        state="disconnected"
        blocked={{ ...runtimeHostBlockedCopy('server-replaced'), recovery: 'open-settings' }}
        onConnect={onConnect}
        onRecover={onRecover}
      />
    )

    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Open settings…' })[0])

    expect(onRecover).toHaveBeenCalledOnce()
    expect(onConnect).not.toHaveBeenCalled()
  })
})
