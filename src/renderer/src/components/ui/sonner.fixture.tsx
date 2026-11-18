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
    // Open after the toast has rendered, so it predates the modal.
    const openTimer = window.setTimeout(() => setSheetOpen(true), 300)
    return () => {
      window.clearTimeout(openTimer)
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

const toasterZIndex = (): number =>
  Number(getComputedStyle(document.querySelector('[data-sonner-toaster]')!).zIndex)

/** Behind a modal Sheet the older toast is dimmed and inert; a press brings it forward and its
 *  close dismisses only the toast, keeping the sheet's draft and focus. */
export const olderToastBehindModalSheet = defineFixture({
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
    assert(toasterZIndex() === 49, 'an older toast should sit behind the sheet backdrop')

    const action = toastElement()!.querySelector<HTMLElement>('[data-button]')!
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert(draft()?.value === DRAFT, 'a lowered toast action must not run')

    const overlay = document.querySelector<HTMLElement>("[data-slot='sheet-overlay']")!
    const rect = toastElement()!.getBoundingClientRect()
    overlay.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2
      })
    )
    await waitFor(() => toasterZIndex() === 60, 'the press to bring the toast forward')
    assert(
      document.querySelector("[data-slot='sheet-content'][data-state='open']") !== null,
      'the press must not dismiss the sheet'
    )

    const close = toastElement()!.querySelector<HTMLElement>('[data-close-button]')!
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
