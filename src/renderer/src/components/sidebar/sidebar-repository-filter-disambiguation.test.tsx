// @vitest-environment happy-dom

// Regression for #6235: two projects whose displayName collides used to render
// as identical rows in both sidebar repository filter surfaces, with nothing
// (path, host) to tell them apart.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { Repo } from '../../../../shared/types'

const duplicateRepos = [
  {
    id: 'repo-alpha',
    path: '/Users/dev/work/alpha/project',
    displayName: 'project',
    badgeColor: '#ff0000',
    addedAt: 1
  },
  {
    id: 'repo-beta',
    path: '/Users/dev/work/beta/project',
    displayName: 'project',
    badgeColor: '#00ff00',
    addedAt: 2
  }
] as Repo[]

const mocks = vi.hoisted(() => ({
  state: {} as Partial<AppState>
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Partial<AppState>) => unknown) => selector(mocks.state)
}))

// Radix portals/tooltips don't render deterministically in happy-dom; the rows
// under test are plain children, so pass them straight through.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'Unassigned'
}))

const roots: Root[] = []

globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(node)
  })
  return container
}

function readProjectRowTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-value^="repo-"]')].map((row) =>
    (row.textContent ?? '').replaceAll(/\s+/gu, ' ').trim()
  )
}

function filterMenuState(repos: Repo[], filterRepoIds: string[] = []): Partial<AppState> {
  return {
    repos,
    filterRepoIds,
    setFilterRepoIds: vi.fn(),
    addRepo: vi.fn(),
    showSleepingWorkspaces: false,
    setShowSleepingWorkspaces: vi.fn(),
    hideDefaultBranchWorkspace: false,
    setHideDefaultBranchWorkspace: vi.fn(),
    hideAutomationGeneratedWorkspaces: false,
    setHideAutomationGeneratedWorkspaces: vi.fn(),
    hideCliCreatedWorkspaces: false,
    setHideCliCreatedWorkspaces: vi.fn(),
    hideDetachedHeadWorkspaces: false,
    setHideDetachedHeadWorkspaces: vi.fn()
  } as Partial<AppState>
}

async function typeInSearch(container: HTMLElement, value: string): Promise<void> {
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('search input not found')
  }
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
  mocks.state = {}
})

describe('#6235 duplicate project names in the sidebar repository filters', () => {
  it('distinguishes same-named projects in the sidebar filter menu', async () => {
    mocks.state = {
      repos: duplicateRepos,
      filterRepoIds: [],
      setFilterRepoIds: vi.fn(),
      addRepo: vi.fn(),
      showSleepingWorkspaces: false,
      setShowSleepingWorkspaces: vi.fn(),
      hideDefaultBranchWorkspace: false,
      setHideDefaultBranchWorkspace: vi.fn(),
      hideAutomationGeneratedWorkspaces: false,
      setHideAutomationGeneratedWorkspaces: vi.fn(),
      hideCliCreatedWorkspaces: false,
      setHideCliCreatedWorkspaces: vi.fn(),
      hideDetachedHeadWorkspaces: false,
      setHideDetachedHeadWorkspaces: vi.fn()
    } as Partial<AppState>

    const { default: SidebarFilter } = await import('./SidebarFilter')
    const container = await render(<SidebarFilter />)
    const rowTexts = readProjectRowTexts(container)

    expect(rowTexts).toHaveLength(2)
    expect(rowTexts[1]).not.toBe(rowTexts[0])
    expect(rowTexts.join(' | ')).toContain('alpha')
  })

  it('distinguishes same-named projects in the repository filter section', async () => {
    mocks.state = {
      repos: duplicateRepos,
      filterRepoIds: [],
      setFilterRepoIds: vi.fn()
    } as Partial<AppState>

    const { default: SidebarRepositoryFilterSection } =
      await import('./SidebarRepositoryFilterSection')
    const container = await render(<SidebarRepositoryFilterSection />)
    const rowTexts = readProjectRowTexts(container)

    expect(rowTexts).toHaveLength(2)
    expect(rowTexts[1]).not.toBe(rowTexts[0])
    expect(rowTexts.join(' | ')).toContain('alpha')
  })

  it('renders the disambiguating label itself, not just distinct row text', async () => {
    mocks.state = filterMenuState(duplicateRepos)

    const { default: SidebarFilter } = await import('./SidebarFilter')
    const container = await render(<SidebarFilter />)

    // The label the sidebar's own project group headers already show, so the
    // filter row and the header above it read identically.
    expect(readProjectRowTexts(container)).toEqual(['alpha/project', 'beta/project'])
  })

  it('leaves uniquely named projects untouched in both surfaces', async () => {
    const uniqueRepos = [
      { id: 'repo-web', path: '/Users/dev/work/web', displayName: 'web', badgeColor: '#f00' },
      { id: 'repo-api', path: '/Users/dev/other/api', displayName: 'api', badgeColor: '#0f0' }
    ] as Repo[]

    mocks.state = filterMenuState(uniqueRepos)
    const { default: SidebarFilter } = await import('./SidebarFilter')
    expect(readProjectRowTexts(await render(<SidebarFilter />))).toEqual(['web', 'api'])

    mocks.state = { repos: uniqueRepos, filterRepoIds: [], setFilterRepoIds: vi.fn() }
    const { default: SidebarRepositoryFilterSection } =
      await import('./SidebarRepositoryFilterSection')
    expect(readProjectRowTexts(await render(<SidebarRepositoryFilterSection />))).toEqual([
      'web',
      'api'
    ])
  })

  it('disambiguates Windows-style paths without leaking backslashes', async () => {
    const windowsRepos = [
      {
        id: 'repo-payments',
        path: 'C:\\Users\\dev\\source\\payments\\api',
        displayName: 'api',
        badgeColor: '#f00'
      },
      {
        id: 'repo-billing',
        path: 'C:\\Users\\dev\\source\\billing\\api',
        displayName: 'api',
        badgeColor: '#0f0'
      }
    ] as Repo[]
    mocks.state = filterMenuState(windowsRepos)

    const { default: SidebarFilter } = await import('./SidebarFilter')
    const container = await render(<SidebarFilter />)

    expect(readProjectRowTexts(container)).toEqual(['payments/api', 'billing/api'])
  })

  it('keeps the SSH badge while disambiguating a remote twin of a local project', async () => {
    const crossHostRepos = [
      { id: 'repo-local', path: '/Users/dev/app', displayName: 'app', badgeColor: '#f00' },
      {
        id: 'repo-remote',
        path: '/Users/dev/app',
        displayName: 'app',
        badgeColor: '#0f0',
        connectionId: 'prod-ssh'
      }
    ] as Repo[]
    mocks.state = filterMenuState(crossHostRepos)

    const { default: SidebarFilter } = await import('./SidebarFilter')
    const container = await render(<SidebarFilter />)
    const rowTexts = readProjectRowTexts(container)

    // Identical paths can't be split by parent segments, so the host names the row.
    expect(rowTexts[0]).toBe('app')
    expect(rowTexts[1]).toBe('app (prod-ssh)SSH')
  })

  it("names the remote twin's host by the user's label, not its generated id", async () => {
    // SshConnectionStore mints ids like this; only sshTargetLabels holds 'My Server'.
    const crossHostRepos = [
      { id: 'repo-local', path: '/Users/dev/app', displayName: 'app', badgeColor: '#f00' },
      {
        id: 'repo-remote',
        path: '/Users/dev/app',
        displayName: 'app',
        badgeColor: '#0f0',
        connectionId: 'ssh-1754190000000-a1b2'
      }
    ] as Repo[]
    mocks.state = {
      ...filterMenuState(crossHostRepos),
      sshTargetLabels: new Map([['ssh-1754190000000-a1b2', 'My Server']])
    } as Partial<AppState>

    const { default: SidebarFilter } = await import('./SidebarFilter')
    expect(readProjectRowTexts(await render(<SidebarFilter />))).toEqual([
      'app',
      'app (My Server)SSH'
    ])

    const { default: SidebarRepositoryFilterSection } =
      await import('./SidebarRepositoryFilterSection')
    expect(readProjectRowTexts(await render(<SidebarRepositoryFilterSection />))).toEqual([
      'app',
      'app (My Server)SSH'
    ])
  })

  it('falls back to the host id when its stored label is blank', async () => {
    // Parity with buildExecutionHostRegistry's `label || targetId`; without it the
    // row reads 'app ()' while the group header for the same repo reads 'app (prod)'.
    const crossHostRepos = [
      { id: 'repo-local', path: '/Users/dev/app', displayName: 'app', badgeColor: '#f00' },
      {
        id: 'repo-remote',
        path: '/Users/dev/app',
        displayName: 'app',
        badgeColor: '#0f0',
        connectionId: 'prod'
      }
    ] as Repo[]
    mocks.state = {
      ...filterMenuState(crossHostRepos),
      sshTargetLabels: new Map([['prod', '   ']])
    } as Partial<AppState>

    const { default: SidebarFilter } = await import('./SidebarFilter')
    expect(readProjectRowTexts(await render(<SidebarFilter />))).toEqual(['app', 'app (prod)SSH'])
  })

  it('keeps a row disambiguated after the search query narrows the list', async () => {
    mocks.state = filterMenuState(duplicateRepos)

    const { default: SidebarFilter } = await import('./SidebarFilter')
    const container = await render(<SidebarFilter />)
    await typeInSearch(container, 'alpha')

    expect(readProjectRowTexts(container)).toEqual(['alpha/project'])
  })

  it('keeps a row disambiguated after its twin moves into the selected pills', async () => {
    mocks.state = {
      repos: duplicateRepos,
      filterRepoIds: ['repo-alpha'],
      setFilterRepoIds: vi.fn()
    } as Partial<AppState>

    const { default: SidebarRepositoryFilterSection } =
      await import('./SidebarRepositoryFilterSection')
    const container = await render(<SidebarRepositoryFilterSection />)

    expect(readProjectRowTexts(container)).toEqual(['beta/project'])
    // The pill and its remove button are the post-selection surface of the same bug.
    expect(container.querySelector('[aria-label="Remove alpha/project filter"]')).not.toBeNull()
  })
})
