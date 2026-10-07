// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  flushEffects,
  listRuntimeFilesMock,
  seedRemoteWorktree
} from '../quick-open-file-list-test-harness'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'

vi.mock('@/runtime/runtime-file-client', async () => {
  const mocks = await import('../__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

describe('useNativeChatMentionFiles', () => {
  it('lists nothing and asks the host for nothing while no token is open', async () => {
    seedRemoteWorktree()
    const { result, unmount } = renderHook(() =>
      useNativeChatMentionFiles({
        query: null,
        terminalTabId: 'tab-1',
        structuredWorktreeId: 'wt-remote'
      })
    )
    await flushEffects()
    expect(result.current.files).toEqual([])
    expect(listRuntimeFilesMock).not.toHaveBeenCalled()
    unmount()
  })
})
