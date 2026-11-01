// @vitest-environment happy-dom

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  PtyFencedTerminationOutcome,
  PtyFencedTerminationRequest
} from '../../../../shared/pty-fenced-termination'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ResourcePtyPanel } from './ResourcePtyPanel'
import { useResourcePtyActions } from './use-resource-pty-actions'
import { useResourceSessionInventory } from './use-resource-session-inventory'
import * as model from './resource-pty-view-model'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))

const VIEWPORT_HEIGHT = 360
const ROW_HEIGHT = 40

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-resource-pty-body') ? VIEWPORT_HEIGHT : ROW_HEIGHT
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return new DOMRect(
      0,
      0,
      400,
      this.hasAttribute('data-resource-pty-body') ? VIEWPORT_HEIGHT : ROW_HEIGHT
    )
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function panelProps(count: number): ComponentProps<typeof ResourcePtyPanel> {
  return {
    active: true,
    inventory: {
      sessionInventory: {
        sessions: Array.from({ length: count }, (_, index) => ({
          id: `pty-${String(index).padStart(5, '0')}`,
          incarnationId: 'A',
          fencedTermination: true,
          cwd: '/notes',
          title: `Terminal ${index}`,
          worktreeId: 'wt-1',
          agentOwnership: 'absent' as const
        })),
        count
      },
      observedAt: 1,
      sessionsError: false,
      loading: false,
      refreshSessions: async () => {},
      clearSessionsError: () => {},
      invalidate: () => {},
      removeSession: () => {},
      removeSessions: () => {}
    },
    actions: {
      ending: new Set(),
      errors: new Map(),
      end: () => {},
      endMany: async () => {}
    },
    onNavigate: () => {},
    bindings: { tabsByWorktree: {}, ptyIdsByTabId: {}, workspaceSessionReady: true },
    worktrees: [makeWorktree('wt-1', 'Notes', { lastActivityAt: 100 })],
    repos: [makeRepo()],
    projectGroups: [],
    runtimePaneTitlesByTabId: {}
  }
}

it.each([1_000, 10_000])(
  'bounds mounted PTY rows for %i sessions and reaches the last row',
  (count) => {
    const props = panelProps(count)
    const view = render(
      <TooltipProvider>
        <ResourcePtyPanel {...props} />
      </TooltipProvider>
    )
    const scroller = view.container.querySelector<HTMLElement>('[data-resource-pty-body]')
    if (!scroller) {
      throw new Error('PTY scroller missing')
    }
    const mountedRows = () => view.container.querySelectorAll('[data-resource-pty-row]')
    expect(mountedRows().length).toBeGreaterThan(0)
    expect(mountedRows().length).toBeLessThan(50)
    expect(mountedRows()[0]?.getAttribute('data-resource-pty-row')).toContain('pty-00000')
    expect(view.container.querySelector('[role="listitem"]')?.getAttribute('aria-setsize')).toBe(
      String(count + 2)
    )
    act(() => {
      scroller.scrollTop = (count + 2) * ROW_HEIGHT - VIEWPORT_HEIGHT
      fireEvent.scroll(scroller)
    })
    expect(mountedRows().length).toBeGreaterThan(0)
    expect(mountedRows().length).toBeLessThan(50)
    expect(
      mountedRows()[mountedRows().length - 1]?.getAttribute('data-resource-pty-row')
    ).toContain(`pty-${String(count - 1).padStart(5, '0')}`)
  }
)

it('skips joins and sorting on scrolling or action updates, and does no model work when inactive', () => {
  const join = vi.spyOn(model, 'buildResourcePtyRows')
  const sort = vi.spyOn(model, 'groupResourcePtyRows')
  const props = panelProps(1_000)
  const panel = (value: typeof props) => (
    <TooltipProvider>
      <ResourcePtyPanel {...value} />
    </TooltipProvider>
  )
  const view = render(panel(props))
  const joined = join.mock.calls.length
  const sorted = sort.mock.calls.length
  const scroller = view.container.querySelector<HTMLElement>('[data-resource-pty-body]')
  if (!scroller) {
    throw new Error('PTY scroller missing')
  }
  act(() => {
    scroller.scrollTop = ROW_HEIGHT * 20
    fireEvent.scroll(scroller)
  })
  view.rerender(panel({ ...props, actions: { ...props.actions, errors: new Map() } }))
  expect(join).toHaveBeenCalledTimes(joined)
  expect(sort).toHaveBeenCalledTimes(sorted)
  view.rerender(panel({ ...props, active: false }))
  const inactiveSorts = sort.mock.calls.length
  view.rerender(panel({ ...props, active: false, worktrees: [...props.worktrees] }))
  expect(join).toHaveBeenCalledTimes(joined)
  expect(sort).toHaveBeenCalledTimes(inactiveSorts)
  expect(view.container.querySelectorAll('[data-resource-pty-row]')).toHaveLength(0)
})

it('selects across virtualized rows, excludes unavailable PTYs, and drops replaced identities', () => {
  const props = panelProps(1_000)
  props.inventory.sessionInventory.sessions[1]!.fencedTermination = false
  props.inventory.sessionInventory.sessions[2]!.exiting = true
  props.actions.ending = new Set([JSON.stringify(['pty-00003', 'A'])])
  const endMany = vi.fn()
  props.actions.endMany = endMany
  const panel = (value: typeof props) => (
    <TooltipProvider>
      <ResourcePtyPanel {...value} />
    </TooltipProvider>
  )
  const view = render(panel(props))
  const selectAll = view.getByRole('checkbox', { name: 'Select all terminals' })
  const first = view.getByRole('checkbox', { name: 'Select Terminal 0' })
  expect(view.getByRole('checkbox', { name: 'Select Terminal 1' }).hasAttribute('disabled')).toBe(
    true
  )
  expect(view.getByRole('checkbox', { name: 'Select Terminal 2' }).hasAttribute('disabled')).toBe(
    true
  )
  fireEvent.click(first)
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  fireEvent.click(selectAll)
  fireEvent.click(view.getByRole('button', { name: 'End selected (997)' }))
  expect(endMany).toHaveBeenCalledTimes(1)
  expect(endMany.mock.calls[0]![0]).toHaveLength(997)
  fireEvent.click(selectAll)
  fireEvent.click(first)
  view.rerender(
    panel({
      ...props,
      inventory: {
        ...props.inventory,
        sessionInventory: {
          ...props.inventory.sessionInventory,
          sessions: props.inventory.sessionInventory.sessions.map((session) => ({
            ...session,
            incarnationId: 'B'
          }))
        }
      }
    })
  )
  expect(view.getByRole('button', { name: 'End selected (0)' }).hasAttribute('disabled')).toBe(true)
})

function LivePtyPanel({
  active,
  props
}: {
  active: boolean
  props: ComponentProps<typeof ResourcePtyPanel>
}) {
  const inventory = useResourceSessionInventory(true, active, true)
  const actions = useResourcePtyActions(inventory)
  return (
    <TooltipProvider>
      <button>Elsewhere</button>
      <ResourcePtyPanel {...props} active={active} inventory={inventory} actions={actions} />
    </TooltipProvider>
  )
}

async function livePanel(count: number) {
  const rect = new DOMRect(0, 0, 400, VIEWPORT_HEIGHT)
  vi.spyOn(Element.prototype, 'getClientRects').mockReturnValue(
    Object.assign([rect], { item: () => rect })
  )
  const props = panelProps(count)
  const list = vi.fn().mockResolvedValue(props.inventory.sessionInventory.sessions)
  const finishes: ((outcome: PtyFencedTerminationOutcome) => void)[] = []
  const kill = vi.fn<
    (request: PtyFencedTerminationRequest) => Promise<PtyFencedTerminationOutcome>
  >(
    () =>
      new Promise<PtyFencedTerminationOutcome>((resolve) => {
        finishes.push(resolve)
      })
  )
  vi.stubGlobal('api', {
    pty: { listSessions: list, killFenced: kill, onSpawned: () => () => {}, onExit: () => () => {} }
  })
  const panel = (active: boolean) => <LivePtyPanel active={active} props={props} />
  const view = render(panel(true))
  await act(async () => {})
  const body = view.container.querySelector<HTMLElement>('[data-resource-pty-body]')
  if (!body) {
    throw new Error('PTY scroller missing')
  }
  body.style.visibility = 'visible'
  const finish = async (outcome: PtyFencedTerminationOutcome) => {
    vi.useFakeTimers()
    if (outcome.outcome === 'ended') {
      const ended = new Set(kill.mock.calls.map(([request]) => request.id))
      list.mockResolvedValue(
        props.inventory.sessionInventory.sessions.filter((session) => !ended.has(session.id))
      )
    }
    await act(async () => {
      finishes.splice(0).forEach((resolve) => resolve(outcome))
      await vi.advanceTimersByTimeAsync(100)
    })
  }
  return {
    ...view,
    body,
    finish,
    kill,
    user: userEvent.setup(),
    setActive: (active: boolean) => view.rerender(panel(active))
  }
}

it.each(['ended', 'refused'] as const)(
  'hands keyboard End focus to the PTY body before disabling a virtualized row, then handles %s',
  async (outcome) => {
    const view = await livePanel(1_000)
    act(() => {
      view.body.scrollTop = 1_002 * ROW_HEIGHT - VIEWPORT_HEIGHT
      fireEvent.scroll(view.body)
    })
    const scrollTop = view.body.scrollTop
    const end = view.getByRole('button', { name: 'End Terminal 999' })
    end.focus()
    await view.user.keyboard('{Enter}')
    expect(view.kill).toHaveBeenCalledTimes(1)
    expect(end.hasAttribute('disabled')).toBe(true)
    expect(document.activeElement).toBe(view.body)
    expect(view.body.scrollTop).toBe(scrollTop)
    await view.finish(outcome === 'ended' ? { outcome } : { outcome, reason: 'claimed' })
    expect(document.activeElement).toBe(view.body)
    if (outcome === 'ended') {
      expect(view.queryByRole('button', { name: 'End Terminal 999' })).toBeNull()
    } else {
      expect(end.hasAttribute('disabled')).toBe(false)
      expect(view.getByRole('alert').textContent).toContain('An agent now owns this terminal')
    }
  }
)

it.each([true, false])(
  'preserves focus moved elsewhere before End completes with panel active=%s',
  async (active) => {
    const view = await livePanel(1)
    view.getByRole('button', { name: 'End Terminal 0' }).focus()
    await view.user.keyboard('{Enter}')
    const elsewhere = view.getByRole('button', { name: 'Elsewhere' })
    elsewhere.focus()
    view.setActive(active)
    await view.finish({ outcome: 'ended' })
    expect(document.activeElement).toBe(elsewhere)
  }
)

it('hands bulk End focus to the body before the selection becomes unavailable', async () => {
  const view = await livePanel(2)
  fireEvent.click(view.getByRole('checkbox', { name: 'Select all terminals' }))
  const end = view.getByRole('button', { name: 'End selected (2)' })
  end.focus()
  await view.user.keyboard('{Enter}')
  expect(view.kill).toHaveBeenCalledTimes(2)
  expect(end.hasAttribute('disabled')).toBe(true)
  expect(document.activeElement).toBe(view.body)
  await view.finish({ outcome: 'ended' })
  expect(view.queryByRole('button', { name: 'End selected (0)' })).toBeNull()
  expect(document.activeElement).toBe(view.body)
})
