// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn(() => true),
  activateTabAndFocusPane: vi.fn(),
  openPopout: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
}))
vi.mock('./useLiveDashboardSnapshot', () => ({
  useLiveDashboardSnapshot: () => ({ generatedAt: 1, cards: [] })
}))
vi.mock('../dashboard-popout/AgentKanbanBoard', () => ({
  AgentKanbanBoard: ({
    onClose,
    onRevealAgent,
    headerActions
  }: ComponentProps<typeof AgentKanbanBoard>) => (
    <>
      <input aria-label="Search agents" />
      <button onClick={onClose}>Close dashboard</button>
      <button
        onClick={() =>
          onRevealAgent?.({ repoId: 'repo', worktreeId: 'worktree', tabId: 'tab', leafId: 'leaf' })
        }
      >
        Reveal agent
      </button>
      {headerActions}
    </>
  )
}))
vi.mock('./AgentDashboardSettingsMenu', () => ({
  AgentDashboardSettingsMenu: ({ onSwitchToPopout }: { onSwitchToPopout: () => void }) => (
    <button onClick={onSwitchToPopout}>Pop out</button>
  )
}))

import { AgentDashboardDrawer } from './AgentDashboardDrawer'

const initialState = useAppStore.getInitialState()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.activateAndRevealWorkspace.mockReturnValue(true)
  useAppStore.setState({ agentDashboardDrawerOpen: false, sidebarOpen: true, sidebarWidth: 320 })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { dashboard: { openPopout: mocks.openPopout } }
  })
})

afterEach(async () => {
  cleanup()
  // Radix schedules close autofocus after unmount, including cleanup.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
})

function Fixture({
  hideOpener = false,
  hideDrawer = false
}: {
  hideOpener?: boolean
  hideDrawer?: boolean
}): React.JSX.Element {
  return (
    <>
      {!hideOpener && (
        <button onClick={() => useAppStore.getState().setAgentDashboardDrawerOpen(true)}>
          Opener A
        </button>
      )}
      <button onClick={() => useAppStore.getState().setAgentDashboardDrawerOpen(true)}>
        Opener B
      </button>
      <input aria-label="Outside input" />
      <button data-workspace-board-preserve-open>Keep open</button>
      {!hideDrawer && <AgentDashboardDrawer statusBarVisible />}
    </>
  )
}

function fixture(): ReturnType<typeof render> {
  return render(<Fixture />)
}

async function openFrom(name = 'Opener A'): Promise<HTMLElement> {
  const opener = screen.getByRole('button', { name })
  opener.focus()
  await userEvent.keyboard('{Enter}')
  expect(document.activeElement).toBe(opener)
  screen.getByRole('textbox', { name: 'Search agents' }).focus()
  return opener
}

async function closed(): Promise<void> {
  await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Search agents' })).toBeNull())
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('AgentDashboardDrawer focus return', () => {
  it.each(['Escape', 'Close dashboard'])('returns to the opener after %s', async (dismiss) => {
    fixture()
    const opener = await openFrom()
    await (dismiss === 'Escape'
      ? userEvent.keyboard('{Escape}')
      : userEvent.click(screen.getByRole('button', { name: dismiss })))
    await closed()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps outside focus when the store closes the drawer', async () => {
    fixture()
    await openFrom()
    const outside = screen.getByRole('textbox', { name: 'Outside input' })
    outside.focus()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(false))
    await closed()
    expect(document.activeElement).toBe(outside)
  })

  it('lets the real outside pointerdown dismissal hand focus to its target', async () => {
    fixture()
    const opener = await openFrom()
    const sheet = screen.getByRole('dialog', { name: 'Agents' })
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(new DOMRect(320, 40, 600, 600))
    const outside = screen.getByRole('textbox', { name: 'Outside input' })
    const returned: Event[] = []
    opener.addEventListener('focus', (event) => returned.push(event))
    await userEvent.pointer({
      target: outside,
      keys: '[MouseLeft]',
      coords: { clientX: 1000, clientY: 100 }
    })
    await closed()
    expect(document.activeElement).toBe(outside)
    expect(returned).toHaveLength(0)
    await userEvent.keyboard('focus-test')
    expect(outside).toHaveValue('focus-test')
  })

  it('restores after store dismissal and captures the next opener', async () => {
    fixture()
    const first = await openFrom()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(false))
    await closed()
    expect(document.activeElement).toBe(first)
    const second = await openFrom('Opener B')
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(document.activeElement).toBe(second)
  })

  it('does not restore during outside pointerdown before the target acquires focus', async () => {
    fixture()
    const opener = await openFrom()
    const sheet = screen.getByRole('dialog', { name: 'Agents' })
    vi.spyOn(sheet, 'getBoundingClientRect').mockReturnValue(new DOMRect(320, 40, 600, 600))
    fireEvent.pointerDown(screen.getByRole('textbox', { name: 'Outside input' }), {
      clientX: 1000,
      clientY: 100
    })
    await closed()
    expect(document.activeElement).not.toBe(opener)
  })

  it('restores when the sidebar host unmounts the drawer', async () => {
    const view = fixture()
    const opener = await openFrom()
    view.rerender(<Fixture hideDrawer />)
    await closed()
    expect(document.activeElement).toBe(opener)
  })

  it.each(['removed', 'disabled', 'hidden', 'inert', 'css-hidden'])(
    'does not restore to a %s opener',
    async (kind) => {
      const view = fixture()
      const opener = await openFrom()
      if (kind === 'removed') {
        view.rerender(<Fixture hideOpener />)
      } else if (kind === 'css-hidden') {
        opener.style.display = 'none'
      } else {
        opener.setAttribute(kind, '')
      }
      await userEvent.keyboard('{Escape}')
      await closed()
      expect(document.activeElement).not.toBe(opener)
    }
  )

  it('does not let an old close callback take focus from a reopened drawer', async () => {
    fixture()
    await openFrom()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(false))
    const second = screen.getByRole('button', { name: 'Opener B' })
    second.focus()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(true))
    const search = screen.getByRole('textbox', { name: 'Search agents' })
    search.focus()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(search)
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(document.activeElement).toBe(second)
  })

  it('does not suppress later Escape restoration after a keep-open interaction', async () => {
    fixture()
    const opener = await openFrom()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Keep open' }), {
      clientX: 1000,
      clientY: 100
    })
    expect(screen.getByRole('textbox', { name: 'Search agents' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await closed()
    expect(document.activeElement).toBe(opener)
  })

  it('returns to the latest opener after consecutive open/close cycles', async () => {
    fixture()
    await openFrom()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(false))
    const second = screen.getByRole('button', { name: 'Opener B' })
    second.focus()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(true))
    screen.getByRole('textbox', { name: 'Search agents' }).focus()
    act(() => useAppStore.getState().setAgentDashboardDrawerOpen(false))
    await closed()
    expect(document.activeElement).toBe(second)
  })

  it.each([true, false])('restores only when agent reveal fails (success: %s)', async (success) => {
    fixture()
    const opener = await openFrom()
    mocks.activateAndRevealWorkspace.mockReturnValue(success)
    await userEvent.click(screen.getByRole('button', { name: 'Reveal agent' }))
    await closed()
    expect(document.activeElement === opener).toBe(!success)
  })

  it('leaves focus handoff to the popout', async () => {
    fixture()
    const opener = await openFrom()
    await userEvent.click(screen.getByRole('button', { name: 'Pop out' }))
    await closed()
    expect(mocks.openPopout).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(opener)
  })
})
