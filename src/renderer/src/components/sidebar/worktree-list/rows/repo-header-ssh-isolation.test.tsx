// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RepoHeaderCreateWorkspaceButton } from './repo-header-project-actions'
import { makeRepo } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { environment, publish, ssh } from '../listing/host-status-test-fixtures'
import type { Repo } from '../../../../../../shared/repo-types'

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
  expect(create).toHaveBeenCalledExactlyOnceWith(repo, { pinHost: false })
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
