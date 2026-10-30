// @vitest-environment happy-dom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RepoHeaderCreateWorkspaceButton } from './repo-header-project-actions'
import { makeRepo } from '../../../worktree-jump-palette-test-fixtures'
import { environment, publish, ssh } from '../listing/host-status-test-fixtures'
import type * as SshGate from '@/lib/repo-ssh-connection'
import type { Repo } from '../../../../../../shared/repo-types'

const work = vi.hoisted(() => ({ authorities: 0, connections: 0 }))
vi.mock('@/lib/repo-ssh-connection', async (original) => {
  const actual = await original<typeof SshGate>()
  return {
    ...actual,
    getRepoSshConnection: (...args: Parameters<typeof actual.getRepoSshConnection>) => {
      work.connections++
      return actual.getRepoSshConnection(...args)
    },
    selectRepoSshGateInput: (...args: Parameters<typeof actual.selectRepoSshGateInput>) => {
      work.authorities++
      return actual.selectRepoSshGateInput(...args)
    }
  }
})
const initial = useAppStore.getInitialState()
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.setState({ runtimeEnvironments: [environment('A'), environment('B')] })
  publish('A', 1)
  publish('B', 1)
  useAppStore.getState().setEnvironmentSshTargetsMetadata('A', [])
  useAppStore
    .getState()
    .setEnvironmentSshConnectionState('A', 'target-0', ssh('connected', 'target-0'))
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

it.each([10, 100])('bounds mounted Create work independently of a %i-target catalog', (size) => {
  const repos: Repo[] = Array.from({ length: size }, (_, index) => ({
    ...makeRepo(),
    id: `repo-${index}`,
    executionHostId: 'runtime:A',
    connectionId: `target-${index}`
  }))
  useAppStore.setState({ repos })
  for (const repo of repos) {
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(
        'A',
        repo.connectionId!,
        ssh('connected', repo.connectionId!)
      )
  }
  let reads = 0
  let observing = false
  const wrapped = new WeakSet<object>()
  function instrument<K, V>(map: Map<K, V>) {
    if (wrapped.has(map)) {
      return
    }
    wrapped.add(map)
    const get = map.get.bind(map)
    map.get = (key) => {
      if (observing) {
        reads++
      }
      return get(key)
    }
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    instrument(state.runtimeStatusByEnvironmentId)
    instrument(state.sshStateByEnvironment)
    instrument(state.sshConnectionStates)
    for (const bucket of state.sshStateByEnvironment.values()) {
      instrument(bucket.connectionStates)
    }
    observing = true
  })
  function publication(write: () => void) {
    observing = false
    act(write)
    observing = false
  }
  let viewportRenders = 0
  const commits = vi.fn()
  const create = vi.fn()
  function PaintedHeaders({ painted }: { painted: Repo[] }) {
    viewportRenders++
    return (
      <TooltipProvider>
        <Profiler id="painted" onRender={commits}>
          {painted.map((repo) => (
            <RepoHeaderCreateWorkspaceButton
              key={repo.id}
              repo={repo}
              label={repo.id}
              onCreateForRepo={create}
            />
          ))}
        </Profiler>
      </TooltipProvider>
    )
  }
  const { rerender, getAllByRole } = render(<PaintedHeaders painted={repos.slice(0, 2)} />)
  const settled = { ...work, commits: commits.mock.calls.length, viewportRenders }
  reads = 0
  for (let sequence = 2; sequence < 12; sequence++) {
    publication(() => publish('B', sequence))
    publication(() =>
      useAppStore
        .getState()
        .setEnvironmentSshConnectionState(
          'B',
          'outside',
          ssh(sequence % 2 ? 'connected' : 'disconnected', 'outside')
        )
    )
    publication(() =>
      useAppStore.setState({
        sshConnectionStates: new Map([
          ['outside', ssh(sequence % 2 ? 'connected' : 'disconnected', 'outside')]
        ])
      })
    )
    publication(() =>
      useAppStore
        .getState()
        .setEnvironmentSshConnectionState(
          'A',
          `target-${size - 1}`,
          ssh(sequence % 2 ? 'connected' : 'disconnected', `target-${size - 1}`)
        )
    )
  }
  expect(work.authorities).toBe(settled.authorities)
  expect(work.connections).toBe(settled.connections)
  expect(commits).toHaveBeenCalledTimes(settled.commits)
  expect(viewportRenders).toBe(settled.viewportRenders)
  // Three selected lookups per mounted consumer; independent of hidden catalog size.
  expect(reads).toBe(40 * 2 * 3)
  const equal = work.authorities
  publication(() => publish('A', 2))
  expect(work.authorities - equal).toBe(2)
  expect(commits).toHaveBeenCalledTimes(settled.commits)
  const equalOwner = work.authorities
  publication(() =>
    useAppStore.getState().setEnvironmentSshConnectionState('A', 'target-0', {
      ...ssh('connected', 'target-0'),
      error: 'diagnostic'
    })
  )
  expect(work.authorities - equalOwner).toBe(1)
  expect(commits).toHaveBeenCalledTimes(settled.commits)
  const baseline = work.authorities
  publication(() => useAppStore.setState({ workspaceHostOrder: ['local'] }))
  expect(work.authorities).toBe(baseline)
  publication(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState('A', 'target-0', ssh('disconnected', 'target-0'))
  )
  expect(getAllByRole('button')[0]?.hasAttribute('disabled')).toBe(true)
  expect(work.authorities - baseline).toBe(1)
  expect(viewportRenders).toBe(settled.viewportRenders)
  expect(commits.mock.calls.length).toBeGreaterThan(settled.commits)
  // A hidden target reads current truth when mounted, including after H=0.
  rerender(<PaintedHeaders painted={[]} />)
  const hidden = work.authorities
  reads = 0
  publication(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(
        'A',
        `target-${size - 1}`,
        ssh('disconnected', `target-${size - 1}`)
      )
  )
  expect(work.authorities).toBe(hidden)
  expect(reads).toBe(0)
  rerender(<PaintedHeaders painted={[repos[size - 1]!]} />)
  expect(getAllByRole('button')[0]?.hasAttribute('disabled')).toBe(true)
  rerender(<PaintedHeaders painted={repos.slice(0, 4)} />)
  reads = 0
  publication(() => publish('B', 12))
  expect(reads).toBe(4 * 3)
  expect(work.authorities).toBe(hidden + 5)
  unsubscribe()
})

it('preserves owner, hydration, transport, refusal, removal and local-missing authority in the real control', () => {
  const repo: Repo = { ...makeRepo(), executionHostId: 'runtime:A', connectionId: 'target-0' }
  const create = vi.fn()
  function Control({ repo }: { repo: Repo }) {
    return (
      <TooltipProvider>
        <RepoHeaderCreateWorkspaceButton repo={repo} label="Project" onCreateForRepo={create} />
      </TooltipProvider>
    )
  }
  const { rerender, getByRole } = render(<Control repo={repo} />)
  const disabled = () => getByRole('button').hasAttribute('disabled')
  expect(disabled()).toBe(false)
  fireEvent.click(getByRole('button'))
  expect(create).toHaveBeenCalledExactlyOnceWith(repo.id)
  act(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState('A', 'target-0', ssh('disconnected', 'target-0'))
  )
  expect(disabled()).toBe(true)
  act(() => useAppStore.getState().markEnvironmentSshStateStale('A'))
  expect(disabled()).toBe(false)
  act(() => useAppStore.getState().setEnvironmentSshTargetsMetadata('A', []))
  expect(disabled()).toBe(false)
  act(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState('A', 'target-0', ssh('disconnected', 'target-0'))
  )
  expect(disabled()).toBe(true)
  const ownerStatus = useAppStore.getState().runtimeStatusByEnvironmentId.get('A')?.status
  if (!ownerStatus) {
    throw new Error('Expected owner status')
  }
  act(() =>
    publish('A', 2, {
      status: ownerStatus,
      verification: 'blocked',
      blockedReason: 'access-revoked'
    })
  )
  expect(disabled()).toBe(false)
  act(() => publish('A', 3, { status: ownerStatus }))
  expect(disabled()).toBe(true)
  act(() => publish('A', 4, { status: null, verification: 'unavailable', transport: 'ready' }))
  expect(disabled()).toBe(true)
  act(() =>
    publish('A', 5, { status: ownerStatus, verification: 'checking', transport: 'connecting' })
  )
  expect(disabled()).toBe(false)
  act(() => publish('A', 6, { status: ownerStatus }))
  expect(disabled()).toBe(true)
  act(() => publish('A', 7, { status: ownerStatus, retired: true }))
  expect(disabled()).toBe(false)
  act(() => publish('A', 8, { status: ownerStatus }))
  expect(disabled()).toBe(true)
  act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
  expect(disabled()).toBe(false)
  act(() => publish('A', 9, { status: ownerStatus }))
  expect(disabled()).toBe(true)
  act(() => useAppStore.setState({ sshStateByEnvironment: new Map() }))
  expect(disabled()).toBe(false)
  act(() => useAppStore.getState().setEnvironmentSshTargetsMetadata('A', []))
  expect(disabled()).toBe(false)
  act(() =>
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState('A', 'target-0', ssh('disconnected', 'target-0'))
  )
  expect(disabled()).toBe(true)
  rerender(<Control repo={{ ...repo, executionHostId: 'runtime:B' }} />)
  expect(disabled()).toBe(false)
  rerender(<Control repo={{ ...repo, executionHostId: 'local', connectionId: 'absent' }} />)
  expect(disabled()).toBe(true)
  act(() =>
    useAppStore.setState({ sshConnectionStates: new Map([['absent', ssh('connected', 'absent')]]) })
  )
  expect(disabled()).toBe(false)
  act(() => useAppStore.setState({ sshConnectionStates: new Map() }))
  expect(disabled()).toBe(true)
  rerender(<Control repo={{ ...repo, executionHostId: 'local', connectionId: undefined }} />)
  expect(disabled()).toBe(false)
  act(() => useAppStore.setState({ runtimeStatusByEnvironmentId: new Map() }))
  expect(disabled()).toBe(false)
})
