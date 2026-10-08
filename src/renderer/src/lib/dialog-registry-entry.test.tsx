// @vitest-environment happy-dom
import { act, StrictMode, Suspense } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CommandDialog } from '@/components/ui/command'
import { useDialogRegistry } from '@/store/dialog-registry'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { selectDialogOnScreen } from '@/store/dialog-registry-state'
import { DialogEntryContent, DialogEntryScope } from './dialog-registry-entry'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  resetDialogRegistryForTests({ startupSettled: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const onScreen = (): boolean => selectDialogOnScreen(useDialogRegistry.getState())

it('an open root with absent or suspended content counts nothing', async () => {
  const pending = new Promise<void>(() => {})
  const Loading = (): never => {
    throw pending
  }
  await act(async () =>
    root.render(
      <Dialog open>
        <Suspense fallback={null}>
          <Loading />
        </Suspense>
      </Dialog>
    )
  )
  expect(onScreen()).toBe(false)
  expect(useDialogRegistry.getState().dialogEntries).toEqual([])
})

it('ordinary content counts through the closing animation, ending only at content unmount', async () => {
  const render = (open: boolean): React.JSX.Element => (
    <Dialog open={open}>
      <DialogContent
        style={{ animationName: open ? 'fade-in' : 'fade-out' }}
        aria-describedby={undefined}
      >
        <DialogTitle>User dialog</DialogTitle>
      </DialogContent>
    </Dialog>
  )
  await act(async () => root.render(render(true)))
  expect(onScreen()).toBe(true)
  const token = useDialogRegistry.getState().dialogEntries[0]?.token
  await act(async () => root.render(render(false)))
  const content = document.querySelector('[data-slot="dialog-content"]')
  expect(content?.getAttribute('data-state')).toBe('closed')
  expect(onScreen()).toBe(true)
  expect(useDialogRegistry.getState().dialogEntries[0]?.token).toBe(token)
  const event = new Event('animationend', { bubbles: true })
  Object.defineProperty(event, 'animationName', { value: 'fade-out' })
  await act(async () => {
    content?.dispatchEvent(event)
  })
  expect(onScreen()).toBe(false)
})

it('uncontrolled dialog and command content register without mirroring their root state', async () => {
  await act(async () =>
    root.render(
      <>
        <Dialog defaultOpen>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>User</DialogTitle>
          </DialogContent>
        </Dialog>
        <CommandDialog defaultOpen />
      </>
    )
  )
  expect(useDialogRegistry.getState().dialogEntries).toHaveLength(2)
})

it('a nested dialog does not reuse the automatic parent token', async () => {
  useDialogRegistry.getState().enqueueAutomaticDialog('tip', 'feature-tip')
  await act(async () =>
    root.render(
      <DialogEntryScope token="tip">
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Tip</DialogTitle>
            <Dialog open>
              <DialogContent aria-describedby={undefined}>
                <DialogTitle>Nested</DialogTitle>
              </DialogContent>
            </Dialog>
          </DialogContent>
        </Dialog>
      </DialogEntryScope>
    )
  )
  const entries = useDialogRegistry.getState().dialogEntries
  expect(entries).toHaveLength(2)
  expect(entries.find((entry) => entry.token === 'tip')?.origin).toBe('automatic')
  expect(entries.find((entry) => entry.token !== 'tip')?.origin).toBe('user')
})

it('custom onboarding content counts only while mounted, including StrictMode replay', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <section role="dialog">
          <DialogEntryContent kind="onboarding" />
        </section>
      </StrictMode>
    )
  )
  expect(useDialogRegistry.getState().dialogEntries).toEqual([
    expect.objectContaining({ kind: 'onboarding', phase: 'visible' })
  ])
  await act(async () => root.render(null))
  expect(onScreen()).toBe(false)
})
