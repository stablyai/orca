import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { showNotePastedToast, showWaitingNoteRefusalToast } from './note-pasted-toast'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'

const target = { kind: 'terminal', tabId: 'stand-in-tab', leafId: 'stand-in-leaf' } as const
const args = { worktreeId: 'synthetic-workspace', target, agentLabel: 'Antigravity' }

const render = (): React.JSX.Element => (
  <>
    <div className="h-[900px]" />
    <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
  </>
)

async function showToast(show: () => void): Promise<void> {
  show()
  const deadline = performance.now() + 5_000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Toast did not mount')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

export const pasting = defineFixture({
  width: 1280,
  render,
  interact: () => showToast(() => showNotePastedToast({ ...args, settleMs: 181_438 }))
})

export const waitingRefusal = defineFixture({
  width: 1280,
  render,
  interact: () =>
    showToast(() =>
      showWaitingNoteRefusalToast({
        ...args,
        settleMs: 181_438,
        readyMessage: activeAgentNotesSendFailureMessage('not-ready', {
          code: 'terminal-draft-pending',
          agent: args.agentLabel
        })
      })
    )
})

export const settled = defineFixture({
  width: 1280,
  render,
  interact: () => showToast(() => showNotePastedToast(args))
})

export const settledRefusal = defineFixture({
  width: 1280,
  render,
  interact: () =>
    showToast(() =>
      showWaitingNoteRefusalToast({
        ...args,
        readyMessage: activeAgentNotesSendFailureMessage('not-ready', {
          code: 'terminal-draft-pending',
          agent: args.agentLabel
        })
      })
    )
})

async function waitForFixture(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error('Notification fixture did not settle')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

function RefusalSheet(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="h-[900px]">
        <Button data-fixture-open-sheet onClick={() => setOpen(true)}>
          Notes
        </Button>
      </div>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Notes</SheetTitle>
            <SheetDescription>Stand-in workspace</SheetDescription>
          </SheetHeader>
        </SheetContent>
      </Sheet>
    </>
  )
}

const refusalMessage = (): string =>
  activeAgentNotesSendFailureMessage('not-ready', {
    code: 'terminal-draft-pending',
    agent: args.agentLabel
  })

async function openSheetOverPasting(): Promise<void> {
  await showToast(() => showNotePastedToast({ ...args, settleMs: 181_438 }))
  document.querySelector<HTMLElement>('[data-fixture-open-sheet]')!.click()
  await waitForFixture(
    () =>
      document.body.hasAttribute('data-modal-overlay-open') &&
      getComputedStyle(document.querySelector('[data-sonner-toaster]')!).zIndex === '49'
  )
}

export const refusalBeforeReannounce = defineFixture({
  width: 1280,
  render: () => <RefusalSheet />,
  interact: openSheetOverPasting
})

export const refusalReannounced = defineFixture({
  width: 1280,
  render: () => <RefusalSheet />,
  interact: async () => {
    await openSheetOverPasting()
    showWaitingNoteRefusalToast({ ...args, settleMs: 181_438, readyMessage: refusalMessage() })
    await waitForFixture(
      () => getComputedStyle(document.querySelector('[data-sonner-toaster]')!).zIndex === '60'
    )
  }
})

export const refusalAfterClosedPasting = defineFixture({
  width: 1280,
  render,
  interact: async () => {
    await showToast(() => showNotePastedToast({ ...args, settleMs: 181_438 }))
    document.querySelector<HTMLElement>('[data-close-button]')!.click()
    await waitForFixture(() => !document.querySelector('[data-sonner-toast]'))
    const readyMessage = refusalMessage()
    showWaitingNoteRefusalToast({ ...args, settleMs: 100, readyMessage })
    await waitForFixture(
      () => !!document.querySelector('[data-sonner-toast]')?.textContent?.includes(readyMessage)
    )
  }
})
