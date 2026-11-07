// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useNativeChatMentionFiles } from './native-chat/use-native-chat-mention-files'
import {
  flushEffects,
  listRuntimeFilesMock,
  makeFolderWorkspace
} from './quick-open-file-list-test-harness'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

vi.mock('@/runtime/files/search/runtime-file-search-client', async () => {
  const mocks = await import('./__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

it.each([
  { hostId: 'local', path: '/local/repo', connectionId: undefined },
  { hostId: 'ssh:box', path: '/remote/repo', connectionId: 'box' }
] as const)(
  'lists chat mentions from the selected $hostId twin of a folder workspace on two hosts',
  async ({ hostId, path, connectionId }) => {
    const twin = { id: 'fw-twin' }
    useAppStore.setState({
      activeWorktreeId: folderWorkspaceKey('fw-twin'),
      activeWorkspaceExecutionHostId: hostId,
      repos: [],
      projectGroups: [],
      worktreesByRepo: {},
      folderWorkspaces: [
        makeFolderWorkspace({ ...twin, folderPath: '/local/repo', executionHostId: 'local' }),
        makeFolderWorkspace({
          ...twin,
          folderPath: '/remote/repo',
          connectionId: 'box',
          executionHostId: 'ssh:box'
        })
      ]
    })
    renderHook(() =>
      useNativeChatMentionFiles({
        // A typed query debounces the remote search; empty lists the catalog at once.
        query: '',
        terminalTabId: 'chat',
        structuredWorktreeId: folderWorkspaceKey('fw-twin')
      })
    )
    await flushEffects()
    expect(listRuntimeFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: path, connectionId }),
      expect.anything()
    )
  }
)
