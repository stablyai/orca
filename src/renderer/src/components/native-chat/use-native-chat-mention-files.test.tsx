// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fileList from '../quick-open-file-list'
import * as fileHistory from '@/lib/quick-open-file-history'
import {
  flushEffects,
  listRuntimeFilesMock,
  seedRemoteWorktree
} from '../quick-open-file-list-test-harness'
import { useNativeChatMentionFiles } from './use-native-chat-mention-files'

vi.mock('@/runtime/runtime-file-search-client', async () => {
  const mocks = await import('../__mocks__/quick-open-runtime-file-client')
  return {
    listRuntimeFiles: mocks.listRuntimeFilesMock,
    cancelRuntimeFileList: mocks.cancelRuntimeFileListMock,
    searchRuntimeFilePaths: mocks.searchRuntimeFilePathsMock
  }
})

describe('useNativeChatMentionFiles', () => {
  afterEach(() => vi.restoreAllMocks())

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

  it('returns the first 20 history-first matches through edits and listing/history replacement', () => {
    seedRemoteWorktree()
    const needles = Array.from({ length: 25 }, (_, index) => `src/needle-${index}.ts`)
    const added = 'src/needle-added.ts'
    const list = vi.spyOn(fileList, 'useRuntimeFileListForWorktree').mockReturnValue({
      files: [...needles, 'src/new.ts'],
      loading: false,
      loadError: null
    })
    const history = vi
      .spyOn(fileHistory, 'useQuickOpenHistory')
      .mockReturnValue(['src/new.ts', added, needles[24], needles[23], 'missing.ts'])
    const initialProps: { query: string | null } = { query: null }
    const { result, rerender, unmount } = renderHook(
      ({ query }: { query: string | null }) =>
        useNativeChatMentionFiles({
          query,
          terminalTabId: 'tab-1',
          structuredWorktreeId: 'wt-remote'
        }),
      { initialProps }
    )
    expect(result.current.files).toEqual([])
    rerender({ query: 'n' })
    const broad = ['src/new.ts', needles[24], needles[23], ...needles.slice(0, 17)]
    expect(result.current.files).toEqual(broad)
    rerender({ query: 'needle' })
    expect(result.current.files).toEqual([needles[24], needles[23], ...needles.slice(0, 18)])
    rerender({ query: 'n' })
    expect(result.current.files).toEqual(broad)

    rerender({ query: 'needle' })
    list.mockReturnValue({
      files: [...needles.slice(0, 24), added],
      loading: false,
      loadError: null
    })
    rerender({ query: 'needle' })
    expect(result.current.files).toEqual([added, needles[23], ...needles.slice(0, 18)])
    history.mockReturnValue([needles[3], 'missing.ts'])
    rerender({ query: 'needle' })
    expect(result.current.files).toEqual([
      needles[3],
      ...needles.slice(0, 20).filter((path) => path !== needles[3])
    ])
    unmount()
  })
})
