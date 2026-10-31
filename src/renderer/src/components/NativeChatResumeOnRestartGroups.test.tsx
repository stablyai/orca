import * as workspaceLookups from './native-chat-resume-workspace-lookups'
import { getProjectGroupingIndexFromState } from '../store/project-host-setup-selector'
import * as rawGroupIndex from '../lib/worktree-runtime-owner-index'
import * as workspaceDisplay from './native-chat-resume-workspace-display'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import * as resumeGrouping from './native-chat-resume-on-restart-grouping'
import { selectProjectCloneUrlPrefill } from '../lib/project-clone-url-prefill'
// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as worktreeIds from '../../../shared/worktree/id'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  candidate,
  chatBox,
  itemOf,
  lineage,
  nodeBox,
  onToggleSpy,
  seedTree,
  treeOutline,
  worktree
} from './native-chat-resume-tree.test-support'
import { ResumeTreeHarness as Harness } from './NativeChatResumeTreeHarness.test-support'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLElement

function render(props: React.ComponentProps<typeof Harness>): void {
  act(() => root.render(<Harness {...props} />))
}

beforeEach(() => {
  onToggleSpy.mockReset()
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  vi.clearAllMocks()
  vi.restoreAllMocks()
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const LOCAL_TREE = [
  '1:project:orca',
  '2:workspace:parent',
  '3:chat:in-parent',
  '3:workspace:child',
  '4:chat:in-child',
  '4:chat:also-in-child',
  '2:workspace:other',
  '3:chat:in-other'
]

it('lists project, workspace and chat levels, a child workspace after its parent’s chats', () => {
  render({ candidates: seedTree() })

  expect(treeOutline()).toEqual(LOCAL_TREE)
})

it('keeps every checkbox in the left column and indents what follows it 18px a level', () => {
  render({ candidates: seedTree() })

  for (const item of container.querySelectorAll<HTMLElement>('[role="treeitem"]')) {
    const row = item.querySelector('label')!
    const cell = (n: number) => row.querySelector<HTMLElement>(`:scope > :nth-child(${n})`)
    const disclosure = cell(3)
    expect(cell(1)?.querySelector('[role="checkbox"]')).not.toBeNull()
    const level = Number(item.getAttribute('aria-level'))
    expect(cell(2)?.style.width).toBe(`${(level - 1) * 18}px`)
    // Every row keeps the arrow's slot, so icons line up; only a node with children has an arrow.
    expect(disclosure?.getAttribute('aria-hidden')).toBe('true')
    const arrow = item.querySelector<HTMLElement>('button[aria-expanded]')
    expect(arrow !== null).toBe(item.hasAttribute('aria-expanded'))
    // Laid over its slot, outside the label, so it never toggles the checkbox.
    expect(arrow?.closest('label') ?? null).toBeNull()
    if (arrow) {
      expect(arrow.style.left).toBe(`${28 + (level - 1) * 18}px`)
    }
  }
})

it('reads levels apart by weight, with no row dividers or bands', () => {
  render({ candidates: seedTree() })

  expect(itemOf(nodeBox('orca')).querySelector('.font-semibold')?.textContent).toBe('orca')
  expect(itemOf(nodeBox('parent')).querySelector('.font-medium')?.textContent).toBe('parent')
  const rows = container.querySelectorAll(
    '[role="treeitem"], [role="treeitem"] *:not([role="checkbox"])'
  )
  for (const element of rows) {
    expect([...element.classList].filter((name) => /^(border|bg-)/.test(name))).toEqual([])
  }
})

it('shows the branch for a git worktree, muted after its name', () => {
  render({ candidates: seedTree() })

  const branch = [...itemOf(nodeBox('parent')).querySelectorAll('span')].find(
    (span) => span.textContent === 'parent-branch'
  )
  expect(branch?.classList.contains('text-muted-foreground')).toBe(true)
})

it('starts at projects when every chat is on this machine', () => {
  render({ candidates: seedTree() })

  expect(container.textContent).not.toContain(getHostContextLabel('local'))
  expect(container.querySelector('[aria-label^="Select all chats on"]')).toBeNull()
})

it('heads a single SSH host with its machine node, named and marked SSH', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  render({ candidates: seedTree({ parent: remote, child: remote }) })

  const machine = getHostContextLabel(remote)
  expect(treeOutline()).toEqual([
    `1:machine:${machine}`,
    ...LOCAL_TREE.map((row) => row.replace(/^(\d)/, (level) => String(Number(level) + 1)))
  ])
  expect(itemOf(nodeBox(machine)).textContent).toContain('SSH')
  // The machine node names the host, so no workspace repeats it.
  expect(itemOf(nodeBox('parent')).textContent).not.toContain(machine)
})

it('heads a runtime host with its machine node and no SSH chip', () => {
  const runtime: ExecutionHostId = 'runtime:env-1'
  render({ candidates: seedTree({ parent: runtime, child: runtime }) })

  const machine = getHostContextLabel(runtime)
  expect(treeOutline()[0]).toBe(`1:machine:${machine}`)
  expect(itemOf(nodeBox(machine)).textContent).not.toContain('SSH')
})

it('names an SSH machine by its saved name, not its target id', () => {
  const targetId = 'ssh-1728291234567-abc12d'
  const remote: ExecutionHostId = `ssh:${targetId}`
  const candidates = seedTree({ parent: remote, child: remote })
  useAppStore.setState({ sshTargetLabels: new Map([[targetId, 'devbox']]) })
  render({ candidates })

  expect(itemOf(nodeBox('devbox')).getAttribute('aria-level')).toBe('1')
  expect(container.textContent).not.toContain(targetId)
})

it('gives each machine its own branch when chats span hosts', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  const candidates = seedTree({ parent: 'local', child: remote })
  render({ candidates })

  const local = getHostContextLabel('local')
  const machine = getHostContextLabel(remote)
  // The child is on another host, so it does not nest under the local parent.
  expect(treeOutline()).toEqual([
    `1:machine:${machine}`,
    '2:project:orca',
    '3:workspace:child',
    '4:chat:in-child',
    '4:chat:also-in-child',
    `1:machine:${local}`,
    '2:project:orca',
    '3:workspace:parent',
    '4:chat:in-parent',
    '3:workspace:other',
    '4:chat:in-other'
  ])
  expect(itemOf(nodeBox(local)).textContent).not.toContain('SSH')
})

it('lists every offered chat exactly once, even with one workspace id on two hosts', () => {
  const remote: ExecutionHostId = 'ssh:build-server'
  const candidates = seedTree()
  const remoteParent = worktree('parent', { hostId: remote, instanceId: 'instance-remote' })
  useAppStore.setState((state) => ({
    worktreesByRepo: { 'repo-1': [...state.worktreesByRepo['repo-1']!, remoteParent] }
  }))
  const twin = candidate('on-remote', remoteParent)
  render({ candidates: [...candidates, twin] })

  for (const entry of [...candidates, twin]) {
    expect(
      container.querySelectorAll(`[role="checkbox"][aria-label*="Prompt ${entry.sessionId}"]`)
    ).toHaveLength(1)
  }
  // Same id, different machine: two separate workspace nodes.
  expect(container.querySelectorAll('[aria-label="Select all chats in parent"]')).toHaveLength(2)
})

it('names a workspace the store does not know by its id, with the kind the host recorded', () => {
  const unknown: ResumeCandidate = {
    ...candidate('lost', worktree('gone')),
    workspaceId: 'folder:missing-folder',
    workspaceKind: 'folder'
  }
  render({ candidates: [unknown] })

  const row = itemOf(nodeBox('folder:missing-folder'))
  expect(row.querySelector('svg.lucide-folder')).not.toBeNull()
  expect(chatBox('lost').getAttribute('aria-label')).toContain('in folder:missing-folder')
})

it('names a git worktree the store does not know by its folder, not its repo-qualified id', () => {
  render({ candidates: [candidate('lost', worktree('blobfish-2'))] })

  expect(nodeBox('blobfish-2')).not.toBeNull()
  expect(chatBox('lost').getAttribute('aria-label')).toContain('in blobfish-2')
  expect(container.textContent).not.toContain('repo-1::')
})

it('disambiguates only colliding unknown folders with linear display work on render', () => {
  const known = worktree('main', { displayName: 'Configured', hostId: 'local' })
  useAppStore.setState({ worktreesByRepo: { 'repo-1': [known] } })
  const controls = [
    candidate('known', known),
    candidate('unique', worktree('blobfish-2')),
    candidate('opaque', worktree('opaque', { id: 'folder:missing-folder' }))
  ]
  const basename = vi.spyOn(worktreeIds, 'getWorktreePathBasenameFromId')
  let nameReads = 0
  const mapSet = Map.prototype.set
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    if (typeof value?.parentPath === 'string' && value.name === 'main') {
      const name = value.name
      Object.defineProperty(value, 'name', {
        get: () => {
          nameReads++
          return name
        }
      })
    }
    return mapSet.call(this, key, value)
  })
  const operations: number[] = []
  let unknown: ResumeCandidate[] = []
  for (const size of [10, 100]) {
    unknown = Array.from({ length: size }, (_, index) =>
      candidate(
        `lost-${index}`,
        worktree('main', {
          id: `repo-1::/Users/test/projects/organization/orca/workspaces/client-${index}/main`
        })
      )
    )
    basename.mockClear()
    nameReads = 0
    render({ candidates: [...controls, ...unknown] })
    const parses = basename.mock.calls.filter(([id]) => id.startsWith('repo-1::/Users/')).length
    const work = parses + nameReads
    expect(Math.min(parses, nameReads)).toBeGreaterThanOrEqual(size)
    expect(work).toBeLessThanOrEqual(6 * size)
    operations.push(work)
    for (const index of [0, 1]) {
      const parent = `/Users/test/projects/organization/orca/workspaces/client-${index}`
      const detail = container.querySelector(`[title="${parent}"]`)
      expect(detail?.textContent).toBe(parent)
      expect(detail?.lastElementChild?.textContent).toBe(`/workspaces/client-${index}`)
      const label = `main (${parent})`
      const row = itemOf(nodeBox(label))
      expect(row.querySelector('.font-medium')?.textContent).toBe('main')
      expect(row.querySelector('button[aria-expanded]')?.getAttribute('aria-label')).toBe(
        `Collapse ${label}`
      )
      expect(chatBox(`lost-${index}`).getAttribute('aria-label')).toContain(`in ${label}`)
    }
    expect(itemOf(nodeBox('Configured')).textContent).toContain('main-branch')
    expect(itemOf(nodeBox('blobfish-2')).querySelector('[title]')).toBeNull()
    expect(nodeBox('folder:missing-folder')).not.toBeNull()
  }
  expect(operations[1]).toBeLessThanOrEqual(12 * operations[0]!)
  const collisionBoxes = container.querySelectorAll<HTMLElement>(
    '[role="checkbox"][aria-label^="Select all chats in main ("]'
  )
  act(() => collisionBoxes[1]!.click())
  expect(onToggleSpy).toHaveBeenCalledExactlyOnceWith('lost-1', false)
  render({ candidates: unknown.slice(0, 2) })
  const hydrated = { ...known, id: unknown[0]!.workspaceId, displayName: 'Resolved' }
  act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [known, hydrated] } }))
  expect(nodeBox('Resolved')).not.toBeNull()
  expect(itemOf(nodeBox('main')).querySelector('[title]')).toBeNull()
  expect(container.querySelector('[aria-label^="Select all chats in main ("]')).toBeNull()
  expect(
    itemOf(nodeBox('main')).querySelector('button[aria-expanded]')?.getAttribute('aria-label')
  ).toBe('Collapse main')
  expect(chatBox('lost-1').getAttribute('aria-label')).toBe(
    'Resume Codex chat "Prompt lost-1" in main'
  )
})

// Its project is unknown too: a nameless "Select all chats in " checkbox would help no one.
it('gives workspaces the store cannot place no project node', () => {
  const unknown: ResumeCandidate = {
    ...candidate('lost', worktree('gone')),
    workspaceId: 'folder:missing-folder',
    workspaceKind: 'folder'
  }
  render({ candidates: [...seedTree(), unknown] })

  expect(treeOutline()).toEqual([...LOCAL_TREE, '1:workspace:folder:missing-folder', '2:chat:lost'])
  expect(container.querySelector('[aria-label="Select all chats in "]')).toBeNull()
})

// Nest only same-host workspaces; unknown host matches only unknown host, as in the sidebar.
it.each([
  ['both local', 'local', 'local', true],
  ['neither with a host id', undefined, undefined, true],
  ['parent without a host id, child local', undefined, 'local', false],
  ['parent local, child without a host id', 'local', undefined, false]
] as const)(
  '%s: nests the child exactly as the sidebar does',
  (_, parentHost, childHost, nests) => {
    render({ candidates: seedTree({ parent: parentHost, child: childHost }) })

    expect(treeOutline()).toContain(nests ? '3:workspace:child' : '2:workspace:child')
    expect(container.querySelectorAll('[role="checkbox"][aria-label^="Resume"]')).toHaveLength(4)
  }
)

it('lists every chat when workspace lineage loops', () => {
  const a = worktree('a')
  const b = worktree('b')
  useAppStore.setState({
    settings: getDefaultSettings(''),
    worktreesByRepo: { 'repo-1': [a, b] },
    worktreeLineageById: { [a.id]: lineage(a, b), [b.id]: lineage(b, a) }
  })
  render({ candidates: [candidate('in-a', a), candidate('in-b', b)] })

  expect(chatBox('in-a')).toBeTruthy()
  expect(chatBox('in-b')).toBeTruthy()
})

it('keeps mounted resume rows and clone-prefill consumers quiet on unrelated writes, with a relevant update control', () => {
  const candidates = seedTree()
  const base = useAppStore.getState().repos[0]
  const remote = {
    ...base,
    id: 'remote',
    path: '/remote',
    executionHostId: 'runtime:server' as const
  }
  useAppStore.setState({ repos: [base, remote] })
  const groupPass = vi.spyOn(resumeGrouping, 'groupResumeWorkspacesByRepo')
  const commits = vi.fn()
  let cloneRenders = 0
  function Prefill() {
    cloneRenders++
    const value = useAppStore((state) =>
      selectProjectCloneUrlPrefill(
        state,
        getProjectGroupingIndexFromState(state).groupByRepoHost.get('local\0repo-1')?.key ?? null
      )
    )
    return <output>{value}</output>
  }
  act(() =>
    root.render(
      <>
        <Profiler id="resume" onRender={commits}>
          <Harness candidates={candidates} />
        </Profiler>
        <Prefill />
      </>
    )
  )
  const initialCloneRenders = cloneRenders
  commits.mockClear()
  groupPass.mockClear()
  act(() => useAppStore.setState({ activeRepoId: 'irrelevant' }))
  expect(commits).not.toHaveBeenCalled()
  expect(cloneRenders).toBe(initialCloneRenders)
  act(() =>
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, terminalFontSize: 20 }
    })
  )
  expect(commits).not.toHaveBeenCalled()
  expect(cloneRenders).toBe(initialCloneRenders)
  act(() =>
    useAppStore.setState({ repos: [base, { ...remote, displayName: 'other host changed' }] })
  )
  expect(groupPass).not.toHaveBeenCalled()
  expect(commits).not.toHaveBeenCalled()
  expect(cloneRenders).toBe(initialCloneRenders)
  act(() => useAppStore.setState({ repos: [{ ...base, displayName: 'renamed' }, remote] }))
  expect(container.textContent).toContain('renamed')
  expect(commits).toHaveBeenCalled()
  act(() =>
    useAppStore.setState({
      repos: [
        {
          ...base,
          gitRemoteIdentity: {
            canonicalKey: 'gitlab.com/org/app',
            remoteName: 'origin',
            remoteUrl: 'https://gitlab.com/org/app.git'
          }
        },
        remote
      ]
    })
  )
  expect(cloneRenders).toBeGreaterThan(initialCloneRenders)
  expect(container.querySelector('output')?.textContent).toBe('https://gitlab.com/org/app.git')
})

function rawFolderGroup(id: string, name = id): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}
function folderRow(index: number, groupId: string): FolderWorkspace {
  return {
    id: `f-${index}`,
    projectGroupId: groupId,
    name: `Workspace ${index}`,
    folderPath: `/folder/${index}`,
    executionHostId: index % 2 ? 'runtime:server' : 'local',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

it.each([
  ['git', 100],
  ['git', 1000],
  ['folder', 100],
  ['folder', 1000]
] as const)(
  'bounds mounted %s resume headers at N=%i with independently replaced G=100/1000',
  (kind, count) => {
    let reads = 0
    let offerReads = 0
    let offerQueries = 0
    const observed = new WeakMap<
      readonly resumeGrouping.ResumeWorkspaceGroup[],
      readonly resumeGrouping.ResumeWorkspaceGroup[]
    >()
    const originalLookup = workspaceLookups.useRepoIdByWorkspace
    vi.spyOn(workspaceLookups, 'useRepoIdByWorkspace').mockImplementation((workspaces) => {
      let counted = observed.get(workspaces)
      if (!counted) {
        counted = [...workspaces]
        workspaces.forEach((group, index) => {
          Object.defineProperty(counted, index, {
            configurable: true,
            enumerable: true,
            get() {
              offerReads++
              return group
            }
          })
        })
        observed.set(workspaces, counted)
      }
      const lookup = originalLookup(counted)
      return (group) => {
        offerQueries++
        return lookup(group)
      }
    })
    const groupsFor = (size: number) =>
      Array.from({ length: size }, (_, i) => ({
        ...rawFolderGroup(`unselected-${i}`),
        get id() {
          reads++
          return `unselected-${i}`
        }
      }))
    const rows = Array.from({ length: count }, (_, i) =>
      worktree(`w-${i}`, {
        repoId: `git-${i}`,
        hostId: i % 2 ? 'runtime:server' : 'local'
      })
    )
    const folders = Array.from({ length: count }, (_, i) => folderRow(i, `missing-${i}`))
    const candidates =
      kind === 'git'
        ? rows.map((row, i) => candidate(`chat-${i}`, row))
        : folders.map((row, i): ResumeCandidate => ({
            sessionId: `chat-${i}`,
            workspaceId: `folder:${row.id}`,
            workspaceKind: 'folder',
            agent: 'codex',
            trigger: 'quit',
            latestPrompt: `Prompt chat-${i}`,
            recordedAt: 0,
            executionHostId: row.executionHostId ?? 'local'
          }))
    const repos = rows.map((row) => ({
      id: row.repoId,
      path: `/git/${row.repoId}`,
      displayName: row.repoId,
      executionHostId: row.hostId,
      badgeColor: '',
      addedAt: 0
    }))
    useAppStore.setState({
      settings: {
        ...getDefaultSettings(''),
        projectGroupingMode: 'folder',
        projectGroupingOverrides: {}
      },
      repos: kind === 'git' ? repos : [],
      projectGroups: groupsFor(100),
      folderWorkspaces: kind === 'folder' ? folders : [],
      worktreesByRepo:
        kind === 'git' ? Object.fromEntries(rows.map((row) => [row.repoId, [row]])) : {}
    })
    const query = vi.spyOn(rawGroupIndex, 'findIndexedProjectGroupDisplay')
    const headers = vi.spyOn(resumeGrouping, 'resolveResumeGroupHeader')
    const workspaceNames = vi.spyOn(workspaceDisplay, 'resolveNames')
    render({ candidates })
    expect(container.querySelectorAll('[role="treeitem"][aria-level="2"]').length).toBe(count)
    expect(container.querySelectorAll('[aria-label*="Prompt chat-"]').length).toBe(count)
    expect(reads).toBe(kind === 'git' ? 0 : 100)
    expect(offerReads).toBeLessThanOrEqual(12 * count)
    expect(offerQueries).toBeGreaterThanOrEqual(count)
    expect(offerQueries).toBeLessThanOrEqual(12 * count)
    process.stdout.write(
      `PG6-D ${JSON.stringify({ kind, count, stage: 'mount', offerReads, offerQueries })}\n`
    )
    const reset = () => {
      reads = 0
      offerReads = 0
      offerQueries = 0
      query.mockClear()
      headers.mockClear()
      workspaceNames.mockClear()
    }
    for (const groupCount of [100, 1000]) {
      if (groupCount === 1000) {
        reset()
        act(() => useAppStore.setState({ projectGroups: groupsFor(groupCount) }))
        expect(reads).toBe(kind === 'git' ? 0 : groupCount)
        expect(headers.mock.calls.length).toBe(0)
        expect(workspaceNames.mock.calls.length).toBe(0)
      }
      const coldReads = kind === 'git' ? 0 : groupCount
      for (const patch of [
        { activeRepoId: `unrelated-${groupCount}` },
        { settings: { ...useAppStore.getState().settings!, terminalFontSize: groupCount } },
        {
          repos: [
            ...useAppStore.getState().repos,
            {
              id: `other-${groupCount}`,
              path: '/other',
              displayName: 'Other',
              executionHostId: 'runtime:other' as const,
              badgeColor: '',
              addedAt: 0
            }
          ]
        },
        { settings: { ...useAppStore.getState().settings!, projectGroupingOverrides: {} } }
      ]) {
        reset()
        act(() => useAppStore.setState(patch))
        expect(reads).toBe(0)
        expect(offerReads).toBeLessThanOrEqual(12 * count)
        expect(offerQueries).toBeLessThanOrEqual(12 * count)
        expect(query.mock.calls.length).toBeLessThanOrEqual(kind === 'git' ? 0 : 4 * count)
        expect(headers.mock.calls.length).toBe(0)
        expect(workspaceNames.mock.calls.length).toBe(0)
      }
      reset()
      const current = useAppStore.getState().projectGroups
      const replaced = [
        ...current.slice(0, -1),
        {
          ...rawFolderGroup(`unselected-${groupCount - 1}`, 'Other host renamed'),
          executionHostId: 'runtime:other'
        }
      ]
      act(() => useAppStore.setState({ projectGroups: replaced }))
      expect(reads).toBe(kind === 'git' ? 0 : groupCount - 1)
      expect(query.mock.calls.length).toBeLessThanOrEqual(kind === 'git' ? 0 : 4 * count)
      expect(headers.mock.calls.length).toBe(0)
      expect(workspaceNames.mock.calls.length).toBe(0)
      process.stdout.write(
        `PG6-C ${JSON.stringify({ kind, count, groupCount, coldReads, replacementReads: reads, replacementQueries: query.mock.calls.length })}\n`
      )
    }
  }
)

it('preserves first raw folder naming, fallback, ticks, order and unaffected sibling rows through real updates', () => {
  const first = rawFolderGroup('same', 'First')
  const later = { ...rawFolderGroup('same', 'Later'), executionHostId: 'runtime:server' }
  const other = rawFolderGroup('other', 'Other')
  const folders = [folderRow(0, 'same'), folderRow(2, 'other')]
  const candidates: ResumeCandidate[] = folders.map((row, i) => ({
    sessionId: `chat-${i}`,
    workspaceId: `folder:${row.id}`,
    workspaceKind: 'folder',
    agent: 'codex',
    trigger: 'quit',
    latestPrompt: `Prompt chat-${i}`,
    recordedAt: 0,
    executionHostId: 'local'
  }))
  useAppStore.setState({ projectGroups: [first, later, other], folderWorkspaces: folders })
  const names = vi.spyOn(workspaceDisplay, 'resolveNames')
  render({ candidates })
  expect(nodeBox('First').getAttribute('aria-checked')).toBe('true')
  const before = treeOutline()
  names.mockClear()
  act(() =>
    useAppStore.setState({
      projectGroups: [first, { ...later, name: 'Ignored later rename' }, other]
    })
  )
  expect(names).not.toHaveBeenCalled()
  expect(treeOutline()).toEqual(before)
  act(() => useAppStore.setState({ projectGroups: [{ ...first, name: '' }, later, other] }))
  expect(nodeBox('')).toBeTruthy()
  expect(names.mock.calls.every((call) => call[2] === 'folder:f-0')).toBe(true)
  names.mockClear()
  act(() => useAppStore.setState({ projectGroups: [later, first, other] }))
  expect(nodeBox('Later')).toBeTruthy()
  expect(names.mock.calls.every((call) => call[2] === 'folder:f-0')).toBe(true)
  act(() => useAppStore.setState({ projectGroups: [other] }))
  expect(nodeBox('same')).toBeTruthy()
  expect(chatBox('chat-0')).toBeTruthy()
  act(() => nodeBox('same').click())
  expect(chatBox('chat-0').getAttribute('aria-checked')).toBe('false')
  expect(chatBox('chat-1').getAttribute('aria-checked')).toBe('true')
  act(() => useAppStore.setState({ projectGroups: [first, other] }))
  expect(nodeBox('First')).toBeTruthy()
  const disclosure = itemOf(nodeBox('First')).querySelector<HTMLButtonElement>(
    'button[aria-expanded]'
  )!
  act(() => disclosure.click())
  expect(container.querySelector('[aria-label*="Prompt chat-0"]')).toBeNull()
  act(() => disclosure.click())
  expect(chatBox('chat-0').getAttribute('aria-checked')).toBe('false')
})

it('keeps offered-object identity, missing/null and current host ownership in the real lookup hook', () => {
  const row = worktree('same', { repoId: 'local-repo', hostId: 'local' })
  const remote = worktree('same', { repoId: 'server-repo', hostId: 'runtime:server' })
  const offered = { workspaceId: row.id, candidates: [candidate('local-chat', row)] }
  const other = { workspaceId: remote.id, candidates: [candidate('server-chat', remote)] }
  const missing = { ...offered }
  const workspaces = [offered, other, offered]
  useAppStore.setState({ worktreesByRepo: { 'local-repo': [row], 'server-repo': [remote] } })
  function Probe() {
    const lookup = workspaceLookups.useRepoIdByWorkspace(workspaces)
    return <output>{JSON.stringify([lookup(offered), lookup(other), lookup(missing)])}</output>
  }
  act(() => root.render(<Probe />))
  expect(container.textContent).toBe('["local-repo","server-repo",null]')
  act(() => useAppStore.setState({ worktreesByRepo: { 'server-repo': [remote] } }))
  expect(container.textContent).toBe('[null,"server-repo",null]')
  act(() =>
    useAppStore.setState({
      worktreesByRepo: { 'local-repo': [{ ...row, repoId: 'late' }], 'server-repo': [remote] }
    })
  )
  expect(container.textContent).toBe('["late","server-repo",null]')
})

it('keeps the real resume route host-qualified and raw folder fallbacks exact through late data and reentry', () => {
  const local = worktree('local', { repoId: 'twin', hostId: 'local' })
  const server = worktree('server', { repoId: 'twin', hostId: 'runtime:server' })
  const blank = worktree('blank', { repoId: 'folder-workspace:', hostId: 'local' })
  const malformed = worktree('malformed', { repoId: 'folder-workspace:%', hostId: 'local' })
  const repos = [
    {
      id: 'twin',
      path: '/local',
      displayName: 'Local checkout',
      badgeColor: '',
      addedAt: 0,
      repoIcon: { type: 'emoji' as const, emoji: '🌿' }
    },
    {
      id: 'twin',
      path: '/server',
      displayName: 'Server checkout',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:server' as const,
      repoIcon: { type: 'emoji' as const, emoji: '🛰️' }
    },
    {
      id: 'folder-workspace:',
      path: '/empty',
      displayName: 'Empty prefix is Git',
      badgeColor: '',
      addedAt: 0
    }
  ]
  const candidates = [local, server, blank, malformed].map((row, i) => candidate(`route-${i}`, row))
  useAppStore.setState({
    repos,
    worktreesByRepo: {
      twin: [local, server],
      'folder-workspace:': [blank],
      'folder-workspace:%': [malformed]
    },
    projectGroups: []
  })
  render({ candidates })
  expect(nodeBox('Local checkout')).toBeTruthy()
  expect(nodeBox('Server checkout')).toBeTruthy()
  expect(container.textContent).toContain('🌿')
  expect(container.textContent).toContain('🛰️')
  expect(nodeBox('Empty prefix is Git')).toBeTruthy()
  expect(nodeBox('%')).toBeTruthy()
  act(() => useAppStore.setState({ projectGroups: [rawFolderGroup('%', 'Late exact')] }))
  expect(nodeBox('Late exact')).toBeTruthy()
  act(() => root.render(null))
  act(() => useAppStore.setState({ repos: [repos[1]!, repos[0]!, repos[2]!] }))
  render({ candidates })
  expect(nodeBox('Local checkout')).toBeTruthy()
  expect(nodeBox('Server checkout')).toBeTruthy()
})
