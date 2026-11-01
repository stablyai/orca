// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_VIEW_OPTIONS,
  WORKSPACE_VIEW_SECTION_LABELS,
  getShownWorkspaceViewSections,
  type WorkspaceViewOptionContext,
  type WorkspaceViewOptionKey
} from '../../../../shared/workspace-view/workspace-view-options'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const hostOptions: { id: string }[] = []
  return { state, hostOptions }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))

vi.mock('./use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: mocks.hostOptions, hostScopeOptions: [] })
}))
vi.mock('./sidebar-host-options', () => ({
  shouldShowHostScopeControls: (hosts: { id: string }[]) => hosts.some((h) => h.id !== 'local'),
  getSidebarHostVisibilityLabel: () => 'All hosts'
}))
vi.mock('./SidebarHostScopeMenuSection', () => ({
  SidebarHostScopeMenuSection: () => <div data-option="hosts">Hosts</div>
}))
vi.mock('./SidebarRepositoryFilterSection', () => ({
  default: () => <div data-option="projects">Projects</div>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>
  return {
    DropdownMenuCheckboxItem: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuShortcut: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: () => null,
    DropdownMenuSubTrigger: Pass,
    DropdownMenuItem: Pass
  }
})

import { WorkspaceOptionsMenuItems } from './workspace-options-menu-items'

const BASE_CONTEXT: WorkspaceViewOptionContext = {
  groupBy: 'none',
  hideSleepingWorkspaces: false,
  hideWorkspacesFromOtherDevices: false,
  newCardStyle: false,
  hasRemoteHosts: false,
  projectCount: 1,
  mayHaveServerHosts: false
}

function setState(context: WorkspaceViewOptionContext, catalogHydrated = true): void {
  mocks.hostOptions = context.hasRemoteHosts ? [{ id: 'local' }, { id: 'ssh:box' }] : []
  const noop = vi.fn()
  mocks.state = {
    repos: Array.from({ length: context.projectCount }, (_, i) => ({ id: `repo-${i}` })),
    groupBy: context.groupBy,
    setGroupBy: noop,
    sortBy: 'name',
    setSortBy: noop,
    projectOrderBy: 'manual',
    setProjectOrderBy: noop,
    showSleepingWorkspaces: !context.hideSleepingWorkspaces,
    setShowSleepingWorkspaces: noop,
    alwaysShowDefaultBranchWorkspace: true,
    setAlwaysShowDefaultBranchWorkspace: noop,
    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: noop,
    hideAutomationGeneratedWorkspaces: false,
    setHideAutomationGeneratedWorkspaces: noop,
    hideCliCreatedWorkspaces: false,
    setHideCliCreatedWorkspaces: noop,
    hideDetachedHeadWorkspaces: false,
    setHideDetachedHeadWorkspaces: noop,
    hideWorkspacesFromOtherDevices: context.hideWorkspacesFromOtherDevices,
    setHideWorkspacesFromOtherDevices: noop,
    hideWorkspaceFilterBadge: false,
    setHideWorkspaceFilterBadge: noop,
    runtimeEnvironments: context.mayHaveServerHosts ? [{ id: 'server' }] : [],
    runtimeEnvironmentCatalogHydrated: catalogHydrated,
    settings: {
      compactWorktreeCards: false,
      experimentalNewWorktreeCardStyle: context.newCardStyle
    },
    worktreeCardProperties: ['status'],
    setWorktreeCardProperties: noop,
    setWorktreeCardMode: noop,
    agentActivityDisplayMode: 'compact',
    setAgentActivityDisplayMode: noop,
    projectGroups: [],
    visibleWorkspaceHostIds: null,
    setVisibleWorkspaceHostIds: noop,
    setWorkspaceHostScope: noop
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

// Probe the control’s own text because Group by’s heading belongs to the whole section.
const PROBE: Partial<Record<WorkspaceViewOptionKey, string>> = {
  groupBy: WORKSPACE_GROUP_BY_CHOICES[0].label
}

function renderedOptionKeys(): WorkspaceViewOptionKey[] {
  const text = container.textContent ?? ''
  return WORKSPACE_VIEW_OPTIONS.map((option) => ({
    key: option.key,
    at: text.indexOf(PROBE[option.key] ?? option.label)
  }))
    .filter((option) => option.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((option) => option.key)
}

const CONTEXTS: WorkspaceViewOptionContext[] = [
  BASE_CONTEXT,
  {
    ...BASE_CONTEXT,
    groupBy: 'repo',
    hideSleepingWorkspaces: true,
    hasRemoteHosts: true,
    projectCount: 3,
    mayHaveServerHosts: true
  },
  { ...BASE_CONTEXT, newCardStyle: true, hideWorkspacesFromOtherDevices: true }
]

describe('Workspace options menu renders from the shared option list', () => {
  for (const context of CONTEXTS) {
    it(`shows one control per shown option, in order: ${JSON.stringify(context)}`, () => {
      setState(context)
      act(() => root.render(<WorkspaceOptionsMenuItems />))
      const sections = getShownWorkspaceViewSections(context)
      expect(renderedOptionKeys()).toEqual(
        sections.flatMap(({ options }) => options.map((option) => option.key))
      )
      for (const { section } of sections) {
        const heading = WORKSPACE_VIEW_SECTION_LABELS[section]
        if (heading) {
          expect(container.textContent).toContain(heading)
        }
      }
    })
  }

  it('renders every option in some context', () => {
    const everShown = new Set(
      CONTEXTS.flatMap((context) =>
        getShownWorkspaceViewSections(context).flatMap(({ options }) =>
          options.map((option) => option.key)
        )
      )
    )
    expect([...everShown].sort()).toEqual(WORKSPACE_VIEW_OPTIONS.map((o) => o.key).sort())
  })

  it('keeps the other-client filter while the server catalog is still loading', () => {
    setState(BASE_CONTEXT, false)
    act(() => root.render(<WorkspaceOptionsMenuItems />))
    expect(renderedOptionKeys()).toContain('hideWorkspacesFromOtherDevices')
  })
})

describe('Hide filter badge toggle interaction', () => {
  /**
   * The badge this switch suppresses lives on the workspace options button, so
   * the switch must live in this same menu, at the end of the Filters section.
   */
  function hideFilterBadgeToggle(): Element {
    const toggle = [...container.querySelectorAll('button[role="switch"]')].find((el) =>
      el.textContent?.includes('Hide filter badge')
    )
    if (!toggle) {
      throw new Error('"Hide filter badge" switch not rendered in the workspace options menu')
    }
    return toggle
  }

  it('sits at the end of the Filters section and forwards clicks to the preference', () => {
    setState(BASE_CONTEXT)
    const setHideWorkspaceFilterBadge = vi.fn()
    mocks.state.setHideWorkspaceFilterBadge = setHideWorkspaceFilterBadge
    act(() => root.render(<WorkspaceOptionsMenuItems />))

    const text = container.textContent ?? ''
    const toggleAt = text.indexOf('Hide filter badge')
    expect(toggleAt).toBeGreaterThanOrEqual(0)
    const lastFilterRowAt = text.lastIndexOf('Hide detached HEAD')
    expect(toggleAt).toBeGreaterThan(lastFilterRowAt)

    expect(hideFilterBadgeToggle().getAttribute('aria-checked')).toBe('false')
    act(() => {
      hideFilterBadgeToggle().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(setHideWorkspaceFilterBadge).toHaveBeenCalledTimes(1)
    expect(setHideWorkspaceFilterBadge).toHaveBeenCalledWith(true)
  })

  it('reflects the persisted preference when the badge is already hidden', () => {
    setState(BASE_CONTEXT)
    mocks.state.hideWorkspaceFilterBadge = true
    act(() => root.render(<WorkspaceOptionsMenuItems />))

    expect(hideFilterBadgeToggle().getAttribute('aria-checked')).toBe('true')
  })
})
