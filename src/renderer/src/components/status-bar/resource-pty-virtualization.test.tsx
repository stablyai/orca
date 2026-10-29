// @vitest-environment happy-dom

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ResourcePtyPanel } from './ResourcePtyPanel'
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
      confirmation: null,
      setConfirmation: () => {},
      ending: new Set(),
      errors: new Map(),
      confirm: () => {},
      endConfirmed: async () => {}
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
