// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DashboardPopoutRoot } from './DashboardPopoutRoot'

vi.mock('./AgentKanbanBoard', () => ({ AgentKanbanBoard: () => <CopyBoard /> }))

const uri = 'https://example.com/exact?raw=%2f#part'
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const liveBridgeSubscriptions = new Set<object>()
function subscribe(): () => void {
  const registration = {}
  liveBridgeSubscriptions.add(registration)
  return () => liveBridgeSubscriptions.delete(registration)
}

// Keep the real root hooks, modal, shared chooser, clipboard hook and feedback receiver.
function CopyBoard(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [request, setRequest] = useState<LinkActionRequest | null>(null)
  const copyRequest: LinkActionRequest = {
    destination: uri,
    copyValue: uri,
    kind: 'url',
    anchorX: 20,
    anchorY: 20,
    primary: { label: 'System Browser', external: true, run: () => {} },
    restoreFocus: () => {}
  }
  return (
    <TooltipProvider>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Terminal preview</DialogTitle>
          <DialogDescription>Popout copy feedback</DialogDescription>
          <input aria-label="Terminal input" defaultValue="keep input" />
          <button onClick={() => setRequest(copyRequest)}>Choose link actions</button>
          <LinkActionPopover
            request={request}
            onClose={() => setRequest(null)}
            onOpenSettings={null}
          />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
}

beforeEach(() => {
  writeClipboardText.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        writeClipboardText,
        onAppMenuPaste: subscribe,
        onEditableContextPaste: subscribe,
        onAppMenuSelectionAction: subscribe
      },
      dashboard: { onSnapshot: subscribe, requestSnapshot: async () => {} },
      agentStatus: { onSet: subscribe, onClear: subscribe },
      telemetryGetConsentState: async () => ({ effective: 'disabled', reason: 'ci' }),
      telemetryTrack: async () => false
    }
  })
})

afterEach(() => {
  cleanup()
  toast.dismiss()
  expect(liveBridgeSubscriptions.size).toBe(0)
})

it.each([
  { result: 'success', message: 'Copied link' },
  { result: 'rejection', message: 'Failed to copy link' }
] as const)(
  'keeps one visible $result outcome after the popout chooser is removed',
  async ({ result, message }) => {
    if (result === 'success') {
      writeClipboardText.mockResolvedValue(undefined)
    } else {
      writeClipboardText.mockRejectedValue(new Error('Clipboard unavailable'))
    }
    const view = render(<DashboardPopoutRoot />)
    expect(document.querySelectorAll('section[aria-label^="Notifications "]')).toHaveLength(1)
    expect(liveBridgeSubscriptions.size).toBe(6)
    fireEvent.click(screen.getByRole('button', { name: 'Choose link actions' }))
    expect(await screen.findByRole('button', { name: /System Browser/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Terminal link settings' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith(uri))
    await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(1))

    const input = screen.getByRole('textbox', { name: 'Terminal input' })
    fireEvent.pointerDown(input)
    await waitFor(() => expect(document.querySelector('[data-link-action-popover]')).toBeNull())
    expect(screen.queryByRole('button', { name: /Copy link|Copied/ })).not.toBeInTheDocument()
    const toaster = document.querySelector('[data-sonner-toaster]')
    if (!(toaster instanceof HTMLElement)) {
      throw new Error('Missing real root feedback receiver')
    }
    expect(within(toaster).getAllByText(message)).toHaveLength(1)
    expect(within(toaster).getByText(message)).toBeVisible()
    expect(toaster.querySelectorAll('[data-sonner-toast]')).toHaveLength(1)
    expect(
      screen.queryByText(result === 'success' ? 'Failed to copy link' : 'Copied link')
    ).toBeNull()

    act(() => input.focus())
    const close = within(toaster).getByRole('button', { name: 'Close toast' })
    fireEvent.pointerDown(close)
    fireEvent.click(close)
    expect(screen.getByRole('dialog', { name: 'Terminal preview' })).toBeInTheDocument()
    expect(input).toHaveValue('keep input')
    expect(input).toHaveFocus()
    await waitFor(() => expect(screen.queryByText(message)).toBeNull())

    view.unmount()
    expect(document.querySelectorAll('section[aria-label^="Notifications "]')).toHaveLength(0)
    expect(liveBridgeSubscriptions.size).toBe(0)
    const remount = render(<DashboardPopoutRoot />)
    expect(document.querySelectorAll('section[aria-label^="Notifications "]')).toHaveLength(1)
    expect(screen.queryByText(message)).toBeNull()
    remount.unmount()
    expect(document.querySelectorAll('section[aria-label^="Notifications "]')).toHaveLength(0)
    expect(liveBridgeSubscriptions.size).toBe(0)
  }
)
