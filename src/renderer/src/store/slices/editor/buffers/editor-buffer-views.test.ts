import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'zustand'
import { useAppStore } from '@/store'
import { drawTabsFromMain } from '../../tabs-drawn-from-main.test-fixture'
import '../../../editor-buffer-record-lifecycle'

import '../actions/editor-draft-state'

import './editor-buffer-record'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

function openEditTab(filePath: string, worktreeId = 'wt-1'): string {
  return useAppStore.getState().openFile(
    {
      filePath,
      relativePath: filePath.slice('/repo/'.length),
      worktreeId,
      runtimeEnvironmentId: null,
      language: 'typescript',
      mode: 'edit'
    },
    { suppressActiveRuntimeFallback: true }
  )
}

describe('editor buffer view index', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
  })

  it('maps each tab to its own record through open, rekey and close', async () => {
    // Layout-owner builds: main answers the rename and its frame shows it; a no-op otherwise.
    const main = await drawTabsFromMain(useAppStore)
    const a = openEditTab('/repo/a.ts')
    const b = openEditTab('/repo/a.ts', 'wt-2')
    await main.settle()
    let state = useAppStore.getState()
    expect(state.editorBufferIdOf).toEqual({ [a]: a, [b]: b })
    expect(state.editorBufferViews).toEqual({ [a]: [a], [b]: [b] })

    state.rekeyOpenFilesForPathChange({
      rekeys: [
        {
          oldFileId: a,
          newFileId: '/repo/z.ts',
          oldFilePath: '/repo/a.ts',
          newFilePath: '/repo/z.ts',
          newRelativePath: 'z.ts'
        }
      ]
    })
    await main.settle()
    state = useAppStore.getState()
    expect(state.editorBufferIdOf).toEqual({ '/repo/z.ts': '/repo/z.ts', [b]: b })

    state.closeFile(b)
    state.closeFile('/repo/z.ts')
    await main.settle()
    main.close()
    expect(useAppStore.getState().editorBufferIdOf).toEqual({})
    expect(useAppStore.getState().editorBufferViews).toEqual({})
  })
})
