// @vitest-environment happy-dom
import { act } from 'react'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as GitIdentityDisplay from '../../../../shared/worktree/git-identity-display'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import FolderWorkspaceSourceControlPanel from './FolderWorkspaceSourceControlPanel'
import { useSourceControlWatchConsumers } from '@/hooks/source-control-watch-consumers'
import {
  useSourceControlScope,
  type SourceControlScope
} from './source-control/panel/worktree-scope'
import { useWorktreeGitStatusObservation } from './source-control/sync/use-worktree-git-status-observation'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'

const probes = vi.hoisted(() => ({
  status: vi.fn(async (_request: { worktreeId: string }) => {}),
  body: vi.fn(),
  header: vi.fn(),
  watches: new Array<string>()
}))
vi.mock('./source-control/sync/git-status-refresh', () => ({
  refreshGitStatusForWorktree: probes.status
}))
vi.mock('./source-control/sync/use-git-status-upstream-ref-watch', () => ({
  useGitStatusUpstreamRefWatch: () => undefined
}))
vi.mock('./source-control/sync/use-refresh-on-host-contact', () => ({
  useRefreshOnHostContact: () => {}
}))
vi.mock('@/lib/worktree-git-copy', () => ({
  resolveWorktreeGitCopyNow: (id: string, hostId: string) => ({
    worktreeId: id,
    hostId,
    transport: { kind: 'local' }
  })
}))
vi.mock('../../../../shared/worktree/git-identity-display', async (original) => {
  const actual = await original<typeof GitIdentityDisplay>()
  return {
    ...actual,
    getWorktreeGitIdentityDisplay: (
      ...args: Parameters<typeof actual.getWorktreeGitIdentityDisplay>
    ) => {
      probes.header(args[0].branch)
      return actual.getWorktreeGitIdentityDisplay(...args)
    }
  }
})
vi.mock('./source-control/panel/panel', () => ({
  SourceControlPanel: () => {
    const scope = useSourceControlScope()
    probes.body(scope?.worktreeId)
    return <div data-commit-owner={scope?.worktreeId} />
  }
}))

// Unlike happy-dom, report every observed section as on screen.
class OnScreenIntersectionObserver {
  private readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe(target: Element): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section hook reads only target and isIntersecting.
    this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as never)
  }
  unobserve(): void {}
  disconnect(): void {}
}

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', OnScreenIntersectionObserver)
  vi.useFakeTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  probes.status.mockClear()
  probes.body.mockClear()
  probes.header.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function Watches() {
  probes.watches = useSourceControlWatchConsumers().map((target) => target.worktreeId)
  return null
}
function setup(count: number) {
  const worktrees: Worktree[] = Array.from({ length: count }, (_, i) => ({
    id: `repo::/child-${i}`,
    repoId: 'repo',
    path: `/child-${i}`,
    branch: `feature-${i}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    displayName: `Child ${i}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: i,
    lastActivityAt: 0,
    hostId: 'local' as const,
    instanceId: `instance-${i}`
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the catalog and status fields consumed by the folder panel.
  useAppStore.setState({
    activeWorktreeId: 'folder:feature',
    activeWorkspaceKey: 'folder:feature',
    activeWorkspaceExecutionHostId: 'local',
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    repos: [{ id: 'repo', displayName: 'Child', path: '/repo', kind: 'git' }],
    worktreesByRepo: { repo: worktrees },
    folderWorkspaces: [
      { id: 'feature', name: 'Feature', folderPath: '/folder', projectGroupId: 'group' }
    ],
    workspaceLineageByChildKey: Object.fromEntries(
      worktrees.map((row, i) => [
        row.id,
        {
          childWorkspaceKey: `worktree:${row.id}`,
          childInstanceId: row.instanceId,
          parentWorkspaceKey: 'folder:feature',
          parentInstanceId: null,
          createdAt: i
        }
      ])
    ),
    gitStatusByWorktree: Object.fromEntries(worktrees.map((row) => [row.id, []]))
  } as unknown as Partial<AppState>)
  return worktrees
}
async function render(visible = true) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <Watches />
        {visible && <FolderWorkspaceSourceControlPanel />}
      </TooltipProvider>
    )
  )
}

it('labels same-repo sections by worktree name and a detached section by its HEAD', async () => {
  const [onBranch, detached] = setup(2)
  useAppStore.setState({
    worktreesByRepo: { repo: [onBranch!, { ...detached!, branch: '', head: 'abc1234def' }] }
  })
  await render()
  expect(
    [...container.querySelectorAll('section button[aria-expanded]')].map(
      (toggle) => toggle.textContent
    )
  ).toEqual(['ChildChild 0feature-0', 'ChildChild 1Detached HEAD · abc1234'])
})

function ScopedStatusObserver({ owner }: { owner: SourceControlScope }) {
  useWorktreeGitStatusObservation(owner, { enabled: true })
  return null
}

it('filters file events by the section runtime host when a same-id local twin exists', async () => {
  const [local] = setup(1)
  const remote = { ...local!, hostId: 'runtime:paired' as const, instanceId: 'remote-instance' }
  const repo = useAppStore.getState().repos[0]!
  const owner: SourceControlScope = {
    worktreeId: remote.id,
    repoId: remote.repoId,
    executionHostId: 'runtime:paired',
    worktree: remote,
    repo,
    attachedAt: 0,
    placementWorkspaceId: 'folder:feature'
  }
  useAppStore.setState({ worktreesByRepo: { repo: [local!, remote] } })
  await act(async () => root.render(<ScopedStatusObserver owner={owner} />))
  expect(probes.status).toHaveBeenCalledTimes(1)
  probes.status.mockClear()
  for (const runtimeEnvironmentId of [null, 'other-runtime', 'paired']) {
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
          detail: {
            runtimeEnvironmentId,
            payload: {
              worktreePath: remote.path,
              events: [{ absolutePath: `${remote.path}/a.ts`, kind: 'change' }]
            }
          }
        })
      )
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(probes.status).toHaveBeenCalledTimes(runtimeEnvironmentId === 'paired' ? 1 : 0)
  }
})

it('includes a paired-runtime descendant of a local attached worktree as a section', async () => {
  const [parent] = setup(1)
  const remote = {
    ...parent!,
    id: 'remote-repo::/remote-child',
    repoId: 'remote-repo',
    path: '/remote-child',
    displayName: 'Remote child',
    hostId: 'runtime:paired' as const,
    runtimeOwnerEnvironmentId: 'paired',
    instanceId: 'remote-instance'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared lineage selector reads only the status descriptor's installation identity.
  useAppStore.setState({
    repos: [
      ...useAppStore.getState().repos,
      {
        id: 'remote-repo',
        displayName: 'Remote',
        path: '/remote',
        kind: 'git',
        executionHostId: 'runtime:paired'
      }
    ],
    worktreesByRepo: { repo: [parent!], 'remote-repo': [remote] },
    ownLineageInstallationId: 'local-install',
    runtimeStatusByEnvironmentId: new Map([
      [
        'paired',
        {
          status: { hostDescriptor: { installationId: 'remote-install' } },
          checkedAt: 1
        }
      ]
    ]),
    crossStoreLineageByStoreKey: {
      paired: {
        [`worktree:${remote.id}`]: {
          childWorkspaceKey: `worktree:${remote.id}`,
          childInstanceId: 'remote-instance',
          parent: {
            installationId: 'local-install',
            workspaceKey: `worktree:${parent!.id}`,
            instanceId: 'instance-0'
          },
          origin: 'manual',
          capture: { source: 'explicit-ui', confidence: 'explicit' },
          createdAt: 2
        }
      }
    },
    gitStatusByWorktree: { [parent!.id]: [], [remote.id]: [] }
  } as unknown as Partial<AppState>)
  await render()
  expect(
    [...container.querySelectorAll('section')].map((section) =>
      section.getAttribute('data-source-control-worktree')
    )
  ).toEqual([parent!.id, 'remote-repo::/remote-child'])
  expect(probes.status.mock.calls.map(([request]) => request.worktreeId)).toEqual([
    parent!.id,
    'remote-repo::/remote-child'
  ])
})
