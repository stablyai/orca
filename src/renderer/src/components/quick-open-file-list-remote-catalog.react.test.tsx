// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  detectedListingFixture,
  repoFixture,
  worktreeFixture
} from './native-chat/native-chat-workspace-test-fixtures'
import { useNativeChatMentionFiles } from './native-chat/use-native-chat-mention-files'
import {
  flushEffects,
  listRuntimeFilesMock,
  renderProbe
} from './quick-open-file-list-test-harness'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

const WORKTREE_ID = 'repo::/srv/worktree'

describe.each(['paired-detected', 'legacy-ssh'] as const)('%s file catalog', (owner) => {
  function seedWorkspace(): void {
    const worktree = worktreeFixture(WORKTREE_ID, '/srv/worktree')
    useAppStore.setState({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'ssh:box',
      repos: [
        repoFixture({
          connectionId: 'box',
          ...(owner === 'paired-detected' ? { executionHostId: 'runtime:hub' } : {})
        })
      ],
      worktreesByRepo: owner === 'legacy-ssh' ? { repo: [worktree] } : {},
      detectedWorktreesByRepo:
        owner === 'paired-detected'
          ? {
              repo: detectedListingFixture([
                { ...worktree, hostId: 'ssh:box', runtimeOwnerEnvironmentId: 'hub' }
              ])
            }
          : {}
    })
  }

  function expectOwnerRequest(): void {
    expect(listRuntimeFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: WORKTREE_ID,
        worktreePath: '/srv/worktree',
        target:
          owner === 'paired-detected'
            ? { kind: 'environment', environmentId: 'hub' }
            : { kind: 'local' },
        connectionId: owner === 'legacy-ssh' ? 'box' : undefined
      }),
      expect.objectContaining({ rootPath: '/srv/worktree' })
    )
  }

  it('lists files through the workspace owner while its SSH host is active', async () => {
    seedWorkspace()
    await renderProbe({ enabled: true, worktreeId: WORKTREE_ID, states: [] })
    expectOwnerRequest()
  })

  it('populates native chat mentions from the same remote catalog', async () => {
    seedWorkspace()
    const { result } = renderHook(() =>
      useNativeChatMentionFiles({
        query: '',
        terminalTabId: 'chat',
        structuredWorktreeId: WORKTREE_ID
      })
    )
    await flushEffects()
    expectOwnerRequest()
    expect(result.current.files).toEqual(['packages/app/package.json'])
  })
})

it('refuses to list when the catalog has conflicting execution hosts', async () => {
  useAppStore.setState({
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: 'ssh:box',
    worktreesByRepo: {
      repo: [
        worktreeFixture(WORKTREE_ID, '/srv/worktree', { hostId: 'local' }),
        worktreeFixture(WORKTREE_ID, '/srv/worktree', { hostId: 'ssh:box' })
      ]
    }
  })
  await renderProbe({ enabled: true, worktreeId: WORKTREE_ID, states: [] })
  expect(listRuntimeFilesMock).not.toHaveBeenCalled()
})
