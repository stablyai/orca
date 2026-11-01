import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Input } from './input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './sheet'
import { Toaster } from './sonner'

const DRAFT = 'Unsaved sheet draft'

function OlderToastOverModalSheet(): React.JSX.Element {
  const [sheetOpen, setSheetOpen] = useState(false)
  const [draft, setDraft] = useState(DRAFT)
  useEffect(() => {
    // Raised before the sheet opens, like a persistent notice that predates the modal.
    toast.warning('A device tried to connect but is not paired', {
      id: 'older-persistent-toast',
      duration: Number.POSITIVE_INFINITY,
      action: { label: 'Open Mobile Settings', onClick: () => setDraft('') }
    })
    setSheetOpen(true)
    return () => {
      toast.dismiss('older-persistent-toast')
    }
  }, [])
  return (
    <>
      <div className="h-[420px]" />
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Task details</SheetTitle>
            <SheetDescription>
              An unsaved edit stays put while toasts are dismissed.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4">
            <Input
              data-fixture-draft
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

/** Above a modal Sheet: message and close stay, actions are hidden, close keeps the draft. */
export const actionsHiddenOverModalSheet = defineFixture({
  width: 900,
  render: () => <OlderToastOverModalSheet />,
  interact: async () => {
    const draft = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>('[data-fixture-draft]')
    const toastElement = (): Element | null => document.querySelector('[data-sonner-toast]')
    await waitFor(
      () => draft() !== null && document.body.hasAttribute('data-modal-overlay-open'),
      'the modal sheet'
    )
    await waitFor(() => toastElement()?.getAttribute('data-mounted') === 'true', 'the toast')
    draft()!.focus()

    const action = toastElement()!.querySelector<HTMLElement>('[data-button]')!
    const close = toastElement()!.querySelector<HTMLElement>('[data-close-button]')!
    assert(getComputedStyle(action).visibility === 'hidden', 'action should be hidden')
    assert(getComputedStyle(close).visibility === 'visible', 'close should stay visible')
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert(draft()?.value === DRAFT, 'a hidden action click must not run')

    close.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(() => toastElement() === null, 'the toast to be dismissed')
    assert(
      document.querySelector("[data-slot='sheet-content'][data-state='open']") !== null,
      'the sheet should stay open'
    )
    assert(draft()?.value === DRAFT, 'the sheet draft should survive')
    assert(document.activeElement === draft(), 'focus should stay in the sheet draft')
  }
})
