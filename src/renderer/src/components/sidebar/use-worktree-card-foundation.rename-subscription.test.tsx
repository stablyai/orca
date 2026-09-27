/** @vitest-environment happy-dom */
/** Render counts pin the narrowed rename selector: only same-ID cards may re-render. */
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { useAppStore } from '@/store'
import { ALL_GROUP_KEY, PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import { shouldBeginWorktreeRename, type WorktreeRenameRequest } from './worktree-card-model'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const originalState = useAppStore.getState()

function makeWorktree(overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'path'>): Worktree {
  return {
    repoId: 'repo-1',
    displayName: 'fixture',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    head: 'abc1234',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

const A_PATH = '/tmp/rename-subscription/wt-a'
const B_PATH = '/tmp/rename-subscription/wt-b'
const C_PATH = '/tmp/rename-subscription/wt-c'
const WSL_PATH = String.raw`\\wsl.localhost\Ubuntu\home\alice\wt-wsl`

const A_ID = `repo-1::${A_PATH}`
const B_ID = `repo-1::${B_PATH}`
const C_ID = `repo-1::${C_PATH}`
const WSL_ID = `repo-1::${WSL_PATH}`

/** Same workspace ID on two hosts — the duplicate rows the header tells apart by rowKey. */
const localA = makeWorktree({ id: A_ID, path: A_PATH, hostId: 'local', displayName: 'A local' })
const sshA = makeWorktree({
  id: A_ID,
  path: A_PATH,
  hostId: 'ssh:remote-1',
  displayName: 'A over ssh'
})
const runtimeA = makeWorktree({
  id: A_ID,
  path: A_PATH,
  hostId: 'runtime:env-1',
  runtimeOwnerEnvironmentId: 'env-1',
  displayName: 'A on a paired runtime'
})
const localB = makeWorktree({ id: B_ID, path: B_PATH, hostId: 'local', displayName: 'B local' })
const localC = makeWorktree({ id: C_ID, path: C_PATH, hostId: 'local', displayName: 'C local' })
const sshC = makeWorktree({
  id: C_ID,
  path: C_PATH,
  hostId: 'ssh:remote-1',
  displayName: 'C over ssh'
})
const wslWorktree = makeWorktree({
  id: WSL_ID,
  path: WSL_PATH,
  hostId: 'local',
  displayName: 'WSL checkout'
})

const localRepo: Repo = {
  id: 'repo-1',
  path: '/tmp/rename-subscription/repo',
  displayName: 'repo-1',
  badgeColor: '#737373',
  addedAt: 1
}
// Why a second repo: the SSH probes need `connectionId` to arm the foundation's SSH selectors.
const sshRepo: Repo = { ...localRepo, connectionId: 'remote-1', executionHostId: 'ssh:remote-1' }

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-ws-1',
    projectGroupId: 'group-1',
    name: 'Folder workspace fixture',
    folderPath: '/tmp/rename-subscription/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

const folderTarget = folderWorkspaceToWorktree(makeFolderWorkspace())
const folderUnrelated = folderWorkspaceToWorktree(
  makeFolderWorkspace({ id: 'folder-ws-2', name: 'Other folder workspace' })
)

type ProbeRecord = { renders: number; request: WorktreeRenameRequest | null }

const records = new Map<string, ProbeRecord>()

function recordFor(label: string): ProbeRecord {
  const existing = records.get(label)
  if (existing) {
    return existing
  }
  const created: ProbeRecord = { renders: 0, request: null }
  records.set(label, created)
  return created
}

function renders(label: string): number {
  return recordFor(label).renders
}

function observed(label: string): WorktreeRenameRequest | null {
  return recordFor(label).request
}

function resetRenderCounts(): void {
  for (const record of records.values()) {
    record.renders = 0
  }
}

function Probe({
  label,
  worktree,
  repo
}: {
  label: string
  worktree: Worktree
  repo: Repo | undefined
}): null {
  const { renamingWorktreeId } = useWorktreeCardFoundation({ worktree, repo })
  const record = recordFor(label)
  record.renders += 1
  record.request = renamingWorktreeId
  return null
}

/** Row keys are built exactly as the sidebar builds them, so host duplicates differ by key. */
function rowKeyFor(section: string, worktree: Worktree): string {
  return `${section}:${getWorktreeHostIdentity(worktree)}`
}

const A_ALL_LOCAL_ROW = rowKeyFor(ALL_GROUP_KEY, localA)
const A_PINNED_LOCAL_ROW = rowKeyFor(PINNED_GROUP_KEY, localA)
const A_ALL_SSH_ROW = rowKeyFor(ALL_GROUP_KEY, sshA)
const A_ALL_RUNTIME_ROW = rowKeyFor(ALL_GROUP_KEY, runtimeA)

const PROBES = [
  { label: 'a-all-local', worktree: localA, repo: localRepo },
  { label: 'a-pinned-local', worktree: localA, repo: localRepo },
  { label: 'a-ssh', worktree: sshA, repo: sshRepo },
  { label: 'a-runtime', worktree: runtimeA, repo: localRepo },
  { label: 'b-all-local', worktree: localB, repo: localRepo },
  { label: 'c-all-local', worktree: localC, repo: localRepo },
  { label: 'c-ssh', worktree: sshC, repo: sshRepo },
  { label: 'wsl-path', worktree: wslWorktree, repo: localRepo },
  { label: 'folder-target', worktree: folderTarget, repo: undefined },
  { label: 'folder-target-with-repo', worktree: folderTarget, repo: localRepo },
  { label: 'folder-unrelated', worktree: folderUnrelated, repo: undefined }
] as const

const MATCHING_A = ['a-all-local', 'a-pinned-local', 'a-ssh', 'a-runtime'] as const
const UNRELATED_TO_A = [
  'b-all-local',
  'c-all-local',
  'c-ssh',
  'wsl-path',
  'folder-target',
  'folder-target-with-repo',
  'folder-unrelated'
] as const

function expectZeroRenders(labels: readonly string[]): void {
  expect(labels.map((label) => [label, renders(label)])).toEqual(labels.map((label) => [label, 0]))
}

function expectRenders(labels: readonly string[], count: number): void {
  expect(labels.map((label) => [label, renders(label)])).toEqual(
    labels.map((label) => [label, count])
  )
}

function expectObservedNull(labels: readonly string[]): void {
  expect(labels.map((label) => [label, observed(label)])).toEqual(
    labels.map((label) => [label, null])
  )
}

function expectObservedExactly(
  labels: readonly string[],
  request: WorktreeRenameRequest | null
): void {
  for (const label of labels) {
    expect(observed(label)).toBe(request)
  }
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function mount(node: ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(node))
}

function unmount(): void {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
}

function setRenameRequest(request: string | WorktreeRenameRequest | null): void {
  // Why one act per write: a batched set+consume collapses to an invisible null-to-null round trip.
  act(() => useAppStore.getState().setRenamingWorktreeId(request))
}

afterEach(() => {
  unmount()
  records.clear()
  useAppStore.setState(originalState, true)
})

describe('worktree card foundation rename subscription', () => {
  beforeEach(() => {
    useAppStore.setState({ renamingWorktreeId: null })
    mount(
      <>
        {PROBES.map((probe) => (
          <Probe key={probe.label} {...probe} />
        ))}
      </>
    )
    resetRenderCounts()
  })

  it('renders only the target workspace on set and on consume', () => {
    const request: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }

    setRenameRequest(request)
    expectRenders(MATCHING_A, 1)
    expectZeroRenders(UNRELATED_TO_A)
    expectObservedExactly(MATCHING_A, request)
    expectObservedNull(UNRELATED_TO_A)

    resetRenderCounts()
    setRenameRequest(null)
    expectRenders(MATCHING_A, 1)
    expectZeroRenders(UNRELATED_TO_A)
    expectObservedNull([...MATCHING_A, ...UNRELATED_TO_A])
  })

  // Why a separate consume case: the combined case aborts at its first failed assertion.
  it('renders no unrelated row when the target rename is consumed', () => {
    setRenameRequest({ worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW })
    resetRenderCounts()

    setRenameRequest(null)
    expectZeroRenders(UNRELATED_TO_A)
    expectObservedNull(UNRELATED_TO_A)
    expectRenders(MATCHING_A, 1)
    expectObservedNull(MATCHING_A)
  })

  it('hands every same-ID row the exact request and leaves row choice to the header', () => {
    const request: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }
    setRenameRequest(request)

    expectObservedExactly(MATCHING_A, request)

    expect(shouldBeginWorktreeRename(observed('a-all-local'), A_ID, A_ALL_LOCAL_ROW)).toBe(true)
    expect(shouldBeginWorktreeRename(observed('a-pinned-local'), A_ID, A_PINNED_LOCAL_ROW)).toBe(
      false
    )
    expect(shouldBeginWorktreeRename(observed('a-ssh'), A_ID, A_ALL_SSH_ROW)).toBe(false)
    expect(shouldBeginWorktreeRename(observed('a-runtime'), A_ID, A_ALL_RUNTIME_ROW)).toBe(false)
    // A different workspace that happens to be asked about the target row stays false.
    expect(shouldBeginWorktreeRename(observed('c-all-local'), C_ID, A_ALL_LOCAL_ROW)).toBe(false)
  })

  it('keeps legacy unscoped requests matching every same-ID row', () => {
    setRenameRequest({ worktreeId: A_ID })

    for (const [label, rowKey] of [
      ['a-all-local', A_ALL_LOCAL_ROW],
      ['a-pinned-local', A_PINNED_LOCAL_ROW],
      ['a-ssh', A_ALL_SSH_ROW],
      ['a-runtime', A_ALL_RUNTIME_ROW]
    ] as const) {
      expect(shouldBeginWorktreeRename(observed(label), A_ID, rowKey)).toBe(true)
    }
    expect(shouldBeginWorktreeRename(observed('b-all-local'), B_ID, undefined)).toBe(false)
  })

  it('does not render for a null-to-null write or a repeat of the same request object', () => {
    setRenameRequest(null)
    expectZeroRenders([...MATCHING_A, ...UNRELATED_TO_A])

    const request: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }
    setRenameRequest(request)
    resetRenderCounts()

    setRenameRequest(request)
    expectZeroRenders([...MATCHING_A, ...UNRELATED_TO_A])
    expectObservedExactly(MATCHING_A, request)
  })

  it('reports a replacement request object with the same ID, with and without the same row', () => {
    setRenameRequest({ worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW })
    resetRenderCounts()

    const sameRow: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }
    setRenameRequest(sameRow)
    expectRenders(MATCHING_A, 1)
    expectZeroRenders(UNRELATED_TO_A)
    expectObservedExactly(MATCHING_A, sameRow)

    resetRenderCounts()
    const otherRow: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_PINNED_LOCAL_ROW }
    setRenameRequest(otherRow)
    expectRenders(MATCHING_A, 1)
    expectZeroRenders(UNRELATED_TO_A)
    expectObservedExactly(MATCHING_A, otherRow)
    expect(shouldBeginWorktreeRename(observed('a-pinned-local'), A_ID, A_PINNED_LOCAL_ROW)).toBe(
      true
    )
    expect(shouldBeginWorktreeRename(observed('a-all-local'), A_ID, A_ALL_LOCAL_ROW)).toBe(false)
  })

  it('keeps the string setter form observable twice, since it mints a new request each call', () => {
    setRenameRequest(A_ID)
    const first = observed('a-all-local')
    expect(first).toEqual({ worktreeId: A_ID })
    resetRenderCounts()

    setRenameRequest(A_ID)
    expectRenders(MATCHING_A, 1)
    expectZeroRenders(UNRELATED_TO_A)
    expect(observed('a-all-local')).not.toBe(first)
    expectObservedExactly(MATCHING_A, observed('a-all-local'))
  })

  it('switches targets without touching unrelated rows', () => {
    const requestA: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }
    setRenameRequest(requestA)
    resetRenderCounts()

    const requestB: WorktreeRenameRequest = {
      worktreeId: B_ID,
      rowKey: rowKeyFor(ALL_GROUP_KEY, localB)
    }
    setRenameRequest(requestB)
    expectRenders(MATCHING_A, 1)
    expectRenders(['b-all-local'], 1)
    expectZeroRenders(['c-all-local', 'c-ssh', 'wsl-path', 'folder-target', 'folder-unrelated'])
    expectObservedNull(MATCHING_A)
    expect(observed('b-all-local')).toBe(requestB)

    resetRenderCounts()
    setRenameRequest(null)
    expectZeroRenders(MATCHING_A)
    expectRenders(['b-all-local'], 1)
    expectObservedNull(['b-all-local'])
  })

  it('renders nothing for a request naming a workspace that is not mounted', () => {
    setRenameRequest({ worktreeId: 'repo-1::/tmp/rename-subscription/never-mounted' })
    expectZeroRenders([...MATCHING_A, ...UNRELATED_TO_A])
    expectObservedNull([...MATCHING_A, ...UNRELATED_TO_A])
  })

  it('targets a folder workspace without rendering git worktree rows', () => {
    const request: WorktreeRenameRequest = {
      worktreeId: folderTarget.id,
      rowKey: rowKeyFor(ALL_GROUP_KEY, folderTarget)
    }
    setRenameRequest(request)

    expectRenders(['folder-target', 'folder-target-with-repo'], 1)
    expectZeroRenders([...MATCHING_A, 'b-all-local', 'c-all-local', 'wsl-path', 'folder-unrelated'])
    expectObservedExactly(['folder-target', 'folder-target-with-repo'], request)
    expectObservedNull(['folder-unrelated'])
    expect(
      shouldBeginWorktreeRename(observed('folder-target'), folderTarget.id, request.rowKey)
    ).toBe(true)

    resetRenderCounts()
    setRenameRequest(null)
    expectRenders(['folder-target', 'folder-target-with-repo'], 1)
    expectZeroRenders([...MATCHING_A, 'folder-unrelated'])
  })

  it('targets a WSL-path workspace without rendering the others', () => {
    const request: WorktreeRenameRequest = {
      worktreeId: WSL_ID,
      rowKey: rowKeyFor(ALL_GROUP_KEY, wslWorktree)
    }
    setRenameRequest(request)

    expectRenders(['wsl-path'], 1)
    expectZeroRenders([...MATCHING_A, 'b-all-local', 'c-all-local', 'folder-target'])
    expect(observed('wsl-path')).toBe(request)
  })
})

describe('worktree card foundation rename subscription across a worktree prop change', () => {
  let setWorktree: ((next: Worktree) => void) | null = null

  beforeEach(() => {
    useAppStore.setState({ renamingWorktreeId: null })

    function SwitchingProbe(): ReactNode {
      const [worktree, setNext] = useState<Worktree>(localA)
      setWorktree = setNext
      return <Probe label="switching" worktree={worktree} repo={localRepo} />
    }

    mount(
      <>
        <SwitchingProbe />
        <Probe label="a-all-local" worktree={localA} repo={localRepo} />
        <Probe label="c-all-local" worktree={localC} repo={localRepo} />
      </>
    )
    resetRenderCounts()
  })

  afterEach(() => {
    setWorktree = null
  })

  it('drops and restores the pending request as the worktree prop moves', () => {
    const request: WorktreeRenameRequest = { worktreeId: A_ID, rowKey: A_ALL_LOCAL_ROW }
    setRenameRequest(request)
    expect(observed('switching')).toBe(request)
    resetRenderCounts()

    // One render is the prop change itself; the point is the value it then selects.
    act(() => setWorktree?.(localB))
    expectRenders(['switching'], 1)
    expectZeroRenders(['a-all-local', 'c-all-local'])
    expect(observed('switching')).toBeNull()

    resetRenderCounts()
    act(() => setWorktree?.(localA))
    expectRenders(['switching'], 1)
    expectZeroRenders(['a-all-local', 'c-all-local'])
    expect(observed('switching')).toBe(request)
  })

  it('keeps the request when only the host changes on the same workspace ID', () => {
    const request: WorktreeRenameRequest = { worktreeId: A_ID }
    setRenameRequest(request)
    resetRenderCounts()

    act(() => setWorktree?.(sshA))
    expect(observed('switching')).toBe(request)
    expectZeroRenders(['a-all-local', 'c-all-local'])
  })
})
