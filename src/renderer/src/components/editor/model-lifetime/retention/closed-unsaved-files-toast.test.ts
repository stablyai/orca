import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClosedUnsavedFile } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'

const mocks = vi.hoisted(() => {
  function nullableActiveWorkspace(): string | null {
    return 'active-wt'
  }
  function nullableActiveHost(): string | null {
    return 'ssh:active'
  }
  const state = {
    activeWorktreeId: nullableActiveWorkspace(),
    activeWorkspaceExecutionHostId: nullableActiveHost(),
    getKnownWorktreeById: vi.fn((_id: string, _host?: string) => ({ path: '/active' })),
    releaseKeptEditorBuffers: vi.fn((_notice: number) => {}),
    openFile: vi.fn()
  }
  return {
    state,
    create: vi.fn(),
    capture: vi.fn(),
    context: vi.fn(),
    assertCurrent: vi.fn(),
    warning: vi.fn(
      (
        _title: string,
        _options: {
          action: { label: string; onClick: (event: { preventDefault: () => void }) => void }
          onDismiss: () => void
        }
      ) => 'notice'
    ),
    error: vi.fn(),
    dismiss: vi.fn()
  }
})
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({
  toast: { warning: mocks.warning, error: mocks.error, dismiss: mocks.dismiss }
}))
vi.mock('@/lib/editor/file-operations/create-untitled-markdown', () => ({
  createUntitledMarkdownFile: mocks.create
}))
vi.mock('@/lib/editor/file-operations/editor-file-operation-owner', () => ({
  getEditorFileOperationContext: mocks.context
}))
vi.mock('@/lib/editor/file-operations/editor-file-operation-provenance', () => ({
  captureEditorFileOperationProvenance: mocks.capture,
  assertEditorFileOperationCurrent: mocks.assertCurrent
}))
import { reopenClosedUnsavedFiles } from './closed-unsaved-files-toast'

function closed(extra: Partial<ClosedUnsavedFile> = {}): ClosedUnsavedFile {
  return {
    fileId: 'a',
    filePath: '/removed/a.ts',
    content: 'unsaved text',
    ...extra
  }
}

describe('closed unsaved files toast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeWorktreeId = 'active-wt'
    mocks.state.activeWorkspaceExecutionHostId = 'ssh:active'
    mocks.capture.mockReturnValue({ generation: { route: { executionHostId: 'ssh:active' } } })
    mocks.context.mockReturnValue({ target: { kind: 'local' } })
    mocks.create.mockImplementation(async (_path, worktreeId, _connection, _target, options) => ({
      filePath: '/active/a (recovered).ts',
      relativePath: 'a (recovered).ts',
      worktreeId,
      language: 'typescript',
      isUntitled: true,
      mode: 'edit',
      deleteUntouchedOnClose: false,
      operationProvenance: options.operationProvenance
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('refuses when the owner route is not the active workspace’s host', async () => {
    mocks.capture.mockReturnValue({ generation: { route: { executionHostId: 'local' } } })
    expect(await reopenClosedUnsavedFiles([closed()])).toHaveLength(1)
  })
})
