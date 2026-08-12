// @vitest-environment happy-dom
import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'
import type { TerminalLinkActionRequest } from './terminal-link-action-request'

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

import { TerminalLinkActionPopover } from './TerminalLinkActionPopover'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('TerminalLinkActionPopover', () => {
  it('shows the full destination and runs the selected action', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const onClose = vi.fn()
    const focusTerminal = vi.fn()
    const run = vi.fn()
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/full/hidden/destination?query=actual',
      kind: 'url',
      primary: { label: 'Open link', run },
      alternate: { external: true, label: 'System Browser', run: vi.fn() },
      focusTerminal
    }

    render(<TerminalLinkActionPopover request={request} onClose={onClose} />)

    const destination = screen.getByText(request.destination)
    expect(destination.className).toContain('line-clamp-2')
    expect(destination.getAttribute('title')).toBe(request.destination)
    expect(screen.getByText('System Browser')).toBeTruthy()
    expect(screen.getAllByText('Click')).toHaveLength(2)
    const textOnlyAction = screen.getByText('Open link').closest('button')
    const externalAction = screen.getByText('System Browser').closest('button')
    expect(textOnlyAction?.querySelector('svg')).toBeNull()
    expect(externalAction?.querySelector('svg')).toBeTruthy()
    expect(externalAction?.className).toContain('has-[>svg]:px-1.5')
    expect(externalAction?.className).not.toContain('has-[>svg]:px-3')
    expect(destination.parentElement?.className).toContain('items-center')
    expect(destination.parentElement?.className).toContain('py-0.5')
    expect(destination.closest('[class*="w-max"]')).toBeTruthy()

    fireEvent.click(screen.getByText('Open link'))
    expect(onClose).toHaveBeenCalledOnce()
    expect(focusTerminal).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledOnce()
  })

  it('identifies the dismissed request so a newer request can survive', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const onClose = vi.fn()
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      focusTerminal: vi.fn()
    }

    render(<TerminalLinkActionPopover request={request} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('dismiss-popover'))

    expect(onClose).toHaveBeenCalledWith(request)
  })

  it('uses distinct icons for system and Orca browser actions', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com',
      kind: 'url',
      primary: { external: false, label: 'Orca Browser', run: vi.fn() },
      alternate: { external: true, label: 'System Browser', run: vi.fn() },
      focusTerminal: vi.fn()
    }

    render(<TerminalLinkActionPopover request={request} onClose={vi.fn()} />)

    expect(
      screen.getByText('Orca Browser').closest('button')?.querySelector('.lucide-globe')
    ).toBeTruthy()
    expect(
      screen.getByText('System Browser').closest('button')?.querySelector('.lucide-external-link')
    ).toBeTruthy()
  })

  it('copies the resolved URL without closing the popover', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
    mocks.writeClipboardText.mockResolvedValue(undefined)
    const onClose = vi.fn()
    const focusTerminal = vi.fn()
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/hidden-destination',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      focusTerminal
    }

    render(<TerminalLinkActionPopover request={request} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledWith(request.destination))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied link')
    expect(onClose).not.toHaveBeenCalled()
    expect(focusTerminal).not.toHaveBeenCalled()
  })

  it('ignores duplicate copy clicks while the clipboard write is in flight', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    Object.assign(window, { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
    let resolveWrite: (() => void) | undefined
    mocks.writeClipboardText.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/hidden-destination',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      focusTerminal: vi.fn()
    }

    render(<TerminalLinkActionPopover request={request} onClose={vi.fn()} />)
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
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com/hidden-destination',
      kind: 'url',
      primary: { label: 'Open link', run: vi.fn() },
      focusTerminal: vi.fn()
    }

    render(<TerminalLinkActionPopover request={request} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to copy link'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(mocks.writeClipboardText).toHaveBeenCalledTimes(2))
  })

  it('does not offer copy link for non-URL destinations', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: '/tmp/example.ts',
      kind: 'file',
      primary: { label: 'Open file', run: vi.fn() },
      focusTerminal: vi.fn()
    }

    render(<TerminalLinkActionPopover request={request} onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull()
  })

  it('opens the terminal link setting from the compact settings button', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const onClose = vi.fn()
    const focusTerminal = vi.fn()
    const request: TerminalLinkActionRequest = {
      paneId: 1,
      anchorX: 100,
      anchorY: 200,
      destination: 'https://example.com',
      kind: 'url',
      primary: { label: 'System Browser', run: vi.fn() },
      focusTerminal
    }

    render(<TerminalLinkActionPopover request={request} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Terminal link settings' }))

    expect(onClose).toHaveBeenCalledOnce()
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'browser',
      repoId: null,
      sectionId: BROWSER_TERMINAL_LINK_ACTIONS_SETTINGS_TARGET_ID
    })
    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(focusTerminal).not.toHaveBeenCalled()
  })
})
