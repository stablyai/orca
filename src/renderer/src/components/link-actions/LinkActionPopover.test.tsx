// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkActionRequest } from './link-action-request'

const mocks = vi.hoisted(() => ({
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  writeClipboardText: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess }
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      openSettingsPage: () => void
      openSettingsTarget: (target: unknown) => void
    }) => unknown
  ) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange
  }: {
    children: ReactNode
    open: boolean
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div>
        <button data-testid="dismiss-popover" onClick={() => onOpenChange(false)} />
        {children}
      </div>
    ) : null,
  PopoverAnchor: () => null,
  PopoverContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  )
}))

import { LinkActionPopover } from './LinkActionPopover'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('LinkActionPopover', () => {
  it('ignores duplicate copy clicks while the clipboard write is in flight', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
    let resolveWrite: (() => void) | undefined
    mocks.writeClipboardText.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    const request: LinkActionRequest = {
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/hidden-destination',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      restoreFocus: vi.fn()
    }

    render(<LinkActionPopover request={request} onClose={vi.fn()} />)
    const copyButton = screen.getByRole('button', { name: 'Copy link' })
    fireEvent.click(copyButton)
    fireEvent.click(copyButton)

    expect(mocks.writeClipboardText).toHaveBeenCalledOnce()
    resolveWrite?.()
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledOnce())
    fireEvent.click(copyButton)
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledTimes(2))
  })

  it('shows a failure toast when copying fails', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
    mocks.writeClipboardText.mockRejectedValue(new Error('denied'))
    const request: LinkActionRequest = {
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/hidden-destination',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      restoreFocus: vi.fn()
    }

    render(<LinkActionPopover request={request} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to copy link'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledTimes(2))
  })

  it('copies the resolved file path without closing the popover', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
    mocks.writeClipboardText.mockResolvedValue(undefined)
    const onClose = vi.fn()
    const request: LinkActionRequest = {
      anchorX: 100,
      anchorY: 200,
      destination: 'file:///repo/src/main.ts',
      copyValue: '/repo/src/main.ts',
      kind: 'file',
      primary: { label: 'Open file', run: vi.fn() },
      restoreFocus: vi.fn()
    }

    render(<LinkActionPopover request={request} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy file path' }))

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith('/repo/src/main.ts'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied file path')
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(['callback', 'omitted'] as const)(
    'retains Settings callback order and hides only explicit omission (%s)',
    (mode) => {
      const order: string[] = []
      const onClose = () => {
        order.push('close')
      }
      const onOpenSettings =
        mode === 'callback'
          ? () => {
              order.push('host')
            }
          : null
      mocks.openSettingsTarget.mockImplementation(() => {
        order.push('target')
      })
      mocks.openSettingsPage.mockImplementation(() => {
        order.push('page')
      })
      const request: LinkActionRequest = {
        anchorX: 0,
        anchorY: 0,
        destination: 'https://example.com',
        kind: 'url',
        primary: { label: 'System Browser', run: vi.fn() },
        restoreFocus: vi.fn()
      }
      render(
        <LinkActionPopover request={request} onClose={onClose} onOpenSettings={onOpenSettings} />
      )
      const gear = screen.queryByRole('button', { name: 'Terminal link settings' })
      if (mode === 'omitted') {
        expect(gear).toBeNull()
        expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy()
        expect(screen.getByRole('button', { name: /System Browser/ })).toBeTruthy()
        expect(order).toEqual([])
      } else {
        fireEvent.click(gear!)
        expect(order).toEqual(['close', 'host', 'target', 'page'])
      }
    }
  )
})
