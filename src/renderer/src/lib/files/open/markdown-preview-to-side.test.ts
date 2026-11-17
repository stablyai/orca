// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { markdownPreviewContent } from '@/components/editor/markdown-preview/markdown-preview-content'
import { openMarkdownPreviewToSide } from './markdown-preview-to-side'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

let main: TabsDrawnFromMain

describe('Markdown preview beside a combined diff', () => {
  beforeEach(async () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    main = await drawTabsFromMain(useAppStore)
  })

  afterEach(() => main.close())

  it('renders the open source tab’s unsaved text rather than the file on disk', async () => {
    const file = {
      filePath: '/repo/docs/notes.md',
      relativePath: 'docs/notes.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null
    }
    useAppStore
      .getState()
      .openFile(
        { ...file, language: 'markdown', mode: 'edit' },
        { suppressActiveRuntimeFallback: true }
      )
    await main.settle()
    const source = useAppStore.getState().openFiles.find((open) => open.mode === 'edit')!
    useAppStore.getState().setEditorDraft(source.id, '# Unsaved heading')

    openMarkdownPreviewToSide({ ...file, sourceGroupId: null })
    await main.settle()

    const state = useAppStore.getState()
    const preview = state.openFiles.find((open) => open.mode === 'markdown-preview')!
    expect(markdownPreviewContent(preview, state.editorDrafts, '# Saved heading').content).toBe(
      '# Unsaved heading'
    )
  })
})
