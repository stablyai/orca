// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT } from '@/constants/terminal'
import { SidebarHeaderActions } from '../sidebar/sidebar-header-actions'
import { AddRepoDialogChrome } from '../sidebar/AddRepoDialogChrome'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useContextualTour } from './use-contextual-tour'

vi.mock('../sidebar/SidebarWorkspaceOptionsMenu', () => ({ default: () => null }))
vi.mock('@/lib/feature-education-telemetry', () => ({
  trackContextualTourShown: vi.fn(),
  trackContextualTourOutcome: vi.fn()
}))

function Workspace() {
  useContextualTour('workspace-agent-sessions', true)
  const modal = useAppStore((state) => state.activeModal)
  const closeModal = useAppStore((state) => state.closeModal)
  return (
    <TooltipProvider>
      <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />
      <div data-contextual-tour-target="terminal-pane-split-target" />
      <AddRepoDialogChrome
        isOpen={modal === 'add-repo'}
        isAdding={false}
        isCloning={false}
        step="add"
        onBack={() => {}}
        onOpenChange={(open) => {
          if (!open) {
            closeModal()
          }
        }}
      >
        <DialogTitle>Add a project</DialogTitle>
        <DialogDescription>Choose a project folder</DialogDescription>
      </AddRepoDialogChrome>
      <ContextualTourOverlay />
    </TooltipProvider>
  )
}

beforeEach(() => {
  Object.assign(window, { api: { ui: { set: () => Promise.resolve() } } })
  useAppStore.setState(
    {
      ...useAppStore.getInitialState(),
      persistedUIReady: true,
      contextualToursAutoEligible: true,
      activeTabId: 'terminal-1'
    },
    true
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return this.hasAttribute('data-contextual-tour-target')
      ? new DOMRect(100, 100, 30, 30)
      : new DOMRect()
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function splitFromTip(): Promise<unknown> {
  const received = new Promise((resolve) => {
    window.addEventListener(
      REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT,
      (event) => {
        if (event instanceof CustomEvent) {
          resolve(event.detail)
        }
      },
      { once: true }
    )
  })
  await userEvent.click(await screen.findByRole('button', { name: 'Split terminal' }))
  return received
}

it('leads from the first project tip to an actionable terminal split', async () => {
  render(<Workspace />)
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
  expect(await splitFromTip()).toEqual({ tabId: 'terminal-1', direction: 'vertical' })
})

it('continues to splitting after the actual Add Project control opens and closes its dialog', async () => {
  render(<Workspace />)
  await screen.findByRole('button', { name: 'Next' })
  await userEvent.click(screen.getByRole('button', { name: 'Add project' }))
  await screen.findByRole('dialog', { name: 'Add a project' })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Next' })).toBeNull())
  await userEvent.click(screen.getByRole('button', { name: 'Close' }))
  expect(await splitFromTip()).toEqual({ tabId: 'terminal-1', direction: 'vertical' })
})
