// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { REQUEST_ACTIVE_TERMINAL_PANE_SPLIT_EVENT } from '@/constants/terminal'
import { SidebarHeaderActions } from '../sidebar/sidebar-header-actions'
import { AddRepoDialogChrome } from '../sidebar/project-admission/dialog/AddRepoDialogChrome'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useContextualTour } from './use-contextual-tour'

vi.mock('../sidebar/worktree-list/controls/SidebarWorkspaceOptionsMenu', () => ({
  default: () => null
}))
vi.mock('@/lib/feature-education-telemetry', () => ({
  trackContextualTourShown: vi.fn(),
  trackContextualTourOutcome: vi.fn()
}))

function Workspace({
  enabled = true,
  hostedOpen = false
}: {
  enabled?: boolean
  hostedOpen?: boolean
}) {
  useContextualTour('workspace-agent-sessions', enabled)
  const modal = useAppStore((state) => state.activeModal)
  const closeModal = useAppStore((state) => state.closeModal)
  const sidebarOpen = useAppStore((state) => state.sidebarOpen)
  const toggleSidebar = useAppStore((state) => state.toggleSidebar)
  return (
    <TooltipProvider>
      <button onClick={toggleSidebar}>Toggle sidebar</button>
      {sidebarOpen && <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />}
      {enabled && <div data-contextual-tour-target="terminal-pane-split-target" />}
      <AddRepoDialogChrome
        isOpen={hostedOpen || modal === 'add-repo'}
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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
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

it('acknowledges Next across interruptions and Back without skipping an unfinished split', async () => {
  const view = render(<Workspace />)
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
  await screen.findByRole('button', { name: 'Split terminal' })
  await userEvent.click(screen.getByRole('button', { name: 'Back' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Next' }))
  view.rerender(<Workspace enabled={false} />)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Split terminal' })).toBeNull())
  view.rerender(<Workspace />)
  expect(await splitFromTip()).toEqual({ tabId: 'terminal-1', direction: 'vertical' })
  await act(async () => {
    await useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
  })
  await screen.findByText('Start another task in parallel')
  await waitFor(() =>
    expect(useAppStore.getState().contextualToursSeenIds).toContain('workspace-agent-sessions')
  )
})

it('keeps terminal splitting available when the project control disappears with the sidebar', async () => {
  render(<Workspace />)
  await screen.findByRole('button', { name: 'Next' })
  await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
  expect(await splitFromTip()).toEqual({ tabId: 'terminal-1', direction: 'vertical' })
})

it('remembers the opened dialog through repeated interruptions and hydrated restart', async () => {
  const view = render(<Workspace />)
  await screen.findByRole('button', { name: 'Next' })
  await userEvent.click(screen.getByRole('button', { name: 'Add project' }))
  await screen.findByRole('dialog', { name: 'Add a project' })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Next' })).toBeNull())
  await userEvent.click(screen.getByRole('button', { name: 'Close' }))
  await screen.findByRole('button', { name: 'Split terminal' })
  view.rerender(<Workspace enabled={false} />)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Split terminal' })).toBeNull())
  view.rerender(<Workspace />)
  await screen.findByRole('button', { name: 'Split terminal' })
  const progress = useAppStore.getState().featureInteractions
  cleanup()
  act(() =>
    useAppStore.setState(
      {
        ...useAppStore.getInitialState(),
        persistedUIReady: true,
        contextualToursAutoEligible: true,
        featureInteractions: progress
      },
      true
    )
  )
  render(<Workspace />)
  await screen.findByRole('button', { name: 'Split terminal' })
  await act(async () => {
    await useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
  })
  await screen.findByText('Start another task in parallel')
})

it('observes hosted dialog opening across hydration, but not its parent composer or a closed dialog', async () => {
  act(() =>
    useAppStore.setState({ persistedUIReady: false, activeModal: 'new-workspace-composer' })
  )
  const view = render(<Workspace enabled={false} />)
  act(() => useAppStore.setState({ persistedUIReady: true }))
  act(() => useAppStore.getState().closeModal())
  view.rerender(<Workspace />)
  await screen.findByRole('button', { name: 'Next' })
  act(() => useAppStore.setState({ persistedUIReady: false }))
  view.rerender(<Workspace enabled={false} hostedOpen />)
  act(() => useAppStore.setState({ persistedUIReady: true }))
  view.rerender(<Workspace />)
  await screen.findByRole('button', { name: 'Split terminal' })
})

it('keeps Parallel owed when splitting succeeds before acknowledging the introduction', async () => {
  const view = render(<Workspace />)
  await screen.findByRole('button', { name: 'Next' })
  await act(async () => {
    await useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
  })
  expect(useAppStore.getState().contextualToursSeenIds).not.toContain('workspace-agent-sessions')
  document.querySelector('[data-contextual-tour-target="workspace-create-control"]')?.remove()
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Next' })).toBeNull())
  expect(screen.queryByRole('button', { name: 'Split terminal' })).toBeNull()
  expect(screen.queryByText('Start another task in parallel')).toBeNull()
  expect(useAppStore.getState().contextualToursSeenIds).not.toContain('workspace-agent-sessions')
  view.rerender(<Workspace enabled={false} />)
  await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
  await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))
  view.rerender(<Workspace />)
  await screen.findByText('Start another task in parallel')
  await waitFor(() =>
    expect(useAppStore.getState().contextualToursSeenIds).toContain('workspace-agent-sessions')
  )
})
