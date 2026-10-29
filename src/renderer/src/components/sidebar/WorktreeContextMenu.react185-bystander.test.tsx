/**
 * @vitest-environment happy-dom
 * Radix may be blamed when its mount effect crosses React’s update limit after an unrelated cascade.
 */
import React, { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { REACT_NESTED_UPDATE_LIMIT } from '../../../../shared/react-update-depth-attribution'
import { TooltipProvider } from '@/components/ui/tooltip'
import WorktreeContextMenu from './WorktreeContextMenu'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const state = {
  unifiedTabsByWorktree: {},
  updateWorktreeMeta: vi.fn(),
  setWorktreesPinnedAndReveal: vi.fn(),
  workspaceStatuses: [
    { id: 'todo', label: 'Todo' },
    { id: 'doing', label: 'Doing' }
  ],
  openModal: vi.fn(),
  projectGroups: [{ id: 'g1', name: 'Group 1' }],
  createProjectGroup: vi.fn(),
  moveProjectToGroup: vi.fn(),
  deleteStateByWorktreeId: {},
  worktreeLineageById: {},
  workspaceLineageByChildKey: {},
  updateWorktreeLineage: vi.fn(),
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  browserTabsByWorktree: {},
  keybindings: {},
  settings: { activeRuntimeEnvironmentId: null, openInApplications: [] },
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useAllWorktrees: () => [],
  useRepoById: (repoId?: string) =>
    repoId ? { id: repoId, name: repoId, displayName: repoId, projectGroupId: null } : undefined,
  useRepoMap: () => new Map(),
  useWorktreeMap: () => new Map()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('./ProjectGroupNameDialog', () => ({ ProjectGroupNameDialog: () => null }))
vi.mock('./WorktreeParentPickerPopover', () => ({ WorktreeParentPickerPopover: () => null }))

const mounted: { container: HTMLDivElement; root: Root }[] = []

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
})

function worktreeFixture(): Worktree {
  return {
    id: 'repo::wt-1',
    repoId: 'repo',
    name: 'wt-1',
    displayName: 'wt-1',
    path: '/path/to/wt-1',
    isMainWorktree: false
  } as unknown as Worktree
}

type Capture = { errors: Error[]; componentStacks: string[] }

class SidebarBoundary extends React.Component<
  { children: React.ReactNode; capture: Capture },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.capture.errors.push(error)
    this.props.capture.componentStacks.push(info.componentStack ?? '')
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

function mount(node: React.ReactNode, capture: Capture): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container, {
    onUncaughtError: (error) => capture.errors.push(error as Error),
    onCaughtError: () => undefined
  })
  mounted.push({ container, root })
  act(() => {
    root.render(
      <SidebarBoundary capture={capture}>
        <TooltipProvider>{node}</TooltipProvider>
      </SidebarBoundary>
    )
  })
  return container
}

/** Model the unrelated cascade driver; the menu itself has no update loop. */
function CommitCascadeDriver({
  ticks,
  onTick
}: {
  ticks: number
  onTick: () => void
}): React.JSX.Element {
  useLayoutEffect(() => {
    if (ticks < REACT_NESTED_UPDATE_LIMIT + 4) {
      onTick()
    }
  })
  return <div data-testid="driver">{ticks}</div>
}

describe('WorktreeContextMenu and React #185', () => {
  it('opening the row context menu on its own does not trip the nested-update limit', () => {
    const capture: Capture = { errors: [], componentStacks: [] }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const container = mount(
      <WorktreeContextMenu worktree={worktreeFixture()}>
        <div data-testid="card-child">Card</div>
      </WorktreeContextMenu>,
      capture
    )

    const scope = container.querySelector('[data-worktree-context-menu-scope]') as HTMLElement
    act(() => {
      scope.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      )
    })
    consoleError.mockRestore()

    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeTruthy()
    expect(capture.errors.map((error) => error.message)).toEqual([])
  })

  it('is blamed for a driver-owned cascade when its items mount past the limit', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const blamedFrames: string[] = []

    // Sweep the opening commit around the update limit because the first blamed fiber depends on React timing.
    for (
      let openAt = REACT_NESTED_UPDATE_LIMIT - 6;
      openAt <= REACT_NESTED_UPDATE_LIMIT;
      openAt++
    ) {
      const capture: Capture = { errors: [], componentStacks: [] }

      function Harness(): React.JSX.Element {
        const [ticks, setTicks] = useState(0)
        const hostRef = React.useRef<HTMLDivElement>(null)
        // Mount menu items while the unrelated driver has already deepened the root’s update counter.
        useLayoutEffect(() => {
          if (ticks !== openAt) {
            return
          }
          hostRef.current
            ?.querySelector('[data-worktree-context-menu-scope]')
            ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        }, [ticks])
        return (
          <>
            <div ref={hostRef}>
              <WorktreeContextMenu worktree={worktreeFixture()}>
                <div data-testid="card-child">Card</div>
              </WorktreeContextMenu>
            </div>
            <CommitCascadeDriver ticks={ticks} onTick={() => setTicks((value) => value + 1)} />
          </>
        )
      }

      mount(<Harness />, capture)

      const depthErrors = capture.errors.filter((error) =>
        error.message.includes('Maximum update depth exceeded')
      )
      expect(depthErrors.length).toBeGreaterThan(0)
      blamedFrames.push(capture.componentStacks[0]?.split('\n')[1]?.trim() ?? '')
    }
    consoleError.mockRestore()

    // Include blamed frames in failures so React/Radix upgrades remain diagnosable.
    const blamed = blamedFrames.map((frame) => frame.split(' (')[0]).join(', ')
    expect(
      blamedFrames.some((frame) => frame.startsWith('at RovingFocusGroupItem')),
      blamed
    ).toBe(true)
    expect(
      blamedFrames.some((frame) => frame.startsWith('at CommitCascadeDriver')),
      blamed
    ).toBe(true)
  })
})
