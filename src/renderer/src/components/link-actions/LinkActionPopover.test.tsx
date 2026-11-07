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
})
