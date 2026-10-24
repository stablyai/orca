// @vitest-environment happy-dom

// The resume tree's shape: levels, depth, where child workspaces go, and when machines show.

import { act } from 'react'
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
    // The checkbox cell comes first, before any indent.
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
  // Every row element but the checkboxes, which keep their own outline.
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

// A paired Orca server's runtime host is not this machine, but it is not SSH either.
it('heads a runtime host with its machine node and no SSH chip', () => {
  const runtime: ExecutionHostId = 'runtime:env-1'
  render({ candidates: seedTree({ parent: runtime, child: runtime }) })

  const machine = getHostContextLabel(runtime)
  expect(treeOutline()[0]).toBe(`1:machine:${machine}`)
  expect(itemOf(nodeBox(machine)).textContent).not.toContain('SSH')
})

// A target saved through Add SSH target gets a generated id; the sidebar names it by its label.
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

// Why: the sidebar nests a child only under a parent on its own host; no host id matches only none.
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
