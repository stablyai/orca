// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { AppOpenFeatureTip } from './feature-tips/AppOpenFeatureTip'
import { useTaskPageGlobalEffects } from './use-task-page-global-effects'

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('./feature-tips/FeatureTipsModal', async () => {
  const ui = await import('./ui/dialog')
  return {
    FeatureTipDialogs: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
      <ui.Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <ui.DialogContent data-testid="feature-tip">
          <ui.DialogTitle>Tip</ui.DialogTitle>
          <button type="button">Got it</button>
        </ui.DialogContent>
      </ui.Dialog>
    )
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const closeTaskPage = vi.fn()

/** The Tasks page's Escape handling, as the page wires it. */
function TasksPage(): null {
  const activeModal = useAppStore((s) => s.activeModal)
  const noop = (): void => {}
  const model = {
    closeTaskPage,
    activeModal,
    preflightStatusChecked: true,
    preflightStatusCurrent: true,
    linearStatusReady: true,
    jiraStatusReady: true,
    checkLinearConnection: noop,
    checkJiraConnection: noop,
    refreshPreflightStatus: noop
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the page model is large; these are the only fields the Escape and preflight effects read when nothing else is open.
  useTaskPageGlobalEffects(model as unknown as Parameters<typeof useTaskPageGlobalEffects>[0])
  return null
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

beforeEach(() => {
  resetDialogRegistryForTests({ startupSettled: true })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ markFeatureTipsSeen: vi.fn() })
  closeTaskPage.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

it('Escape over the launch tip on the Tasks page goes to the tip, not the page', async () => {
  await act(async () =>
    root.render(
      <>
        <TasksPage />
        <AppOpenFeatureTip tipId="orca-cli" />
      </>
    )
  )
  await flush()
  expect(document.querySelector('[data-testid="feature-tip"]')).not.toBeNull()
  // The tip is not in the modal slot; the page still knows a dialog is up.
  expect(useAppStore.getState().activeModal).toBe('none')
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Got it')!
  button.focus()
  act(() => {
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
  await flush()
  expect(closeTaskPage).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid="feature-tip"]')).toBeNull()
})
