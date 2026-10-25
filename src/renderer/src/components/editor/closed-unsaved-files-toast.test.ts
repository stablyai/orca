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
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('sonner', () => ({
  toast: { warning: mocks.warning, error: mocks.error, dismiss: mocks.dismiss }
}))
vi.mock('@/lib/create-untitled-markdown', () => ({ createUntitledMarkdownFile: mocks.create }))
vi.mock('@/lib/editor-file-operation-owner', () => ({
  captureEditorFileOperationProvenance: mocks.capture,
  getEditorFileOperationContext: mocks.context,
  assertEditorFileOperationCurrent: mocks.assertCurrent
}))
import { reopenClosedUnsavedFiles, showClosedUnsavedFilesToast } from './closed-unsaved-files-toast'

function closed(extra: Partial<ClosedUnsavedFile> = {}): ClosedUnsavedFile {
  return {
    fileId: 'a',
    filePath: '/removed/a.ts',
    content: 'unsaved text',
    ...extra
  }
}
function notice() {
  const options = mocks.warning.mock.calls[0]?.[1]
  if (!options) {
    throw new Error('Expected a toast')
  }
  return options
}
const click = () => notice().action.onClick({ preventDefault: vi.fn() })

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

  it('creates new recovered files in the active workspace, with exact text and no original binding', async () => {
    expect(await reopenClosedUnsavedFiles([closed(), closed({ content: '' })])).toEqual([])
    expect(mocks.create).toHaveBeenCalledTimes(2)
    expect(mocks.create).toHaveBeenNthCalledWith(
      1,
      '/active',
      'active-wt',
      undefined,
      { kind: 'local' },
      expect.objectContaining({
        recoveredDocument: { originalPath: '/removed/a.ts', content: 'unsaved text' }
      })
    )
    expect(mocks.create).toHaveBeenNthCalledWith(
      2,
      '/active',
      'active-wt',
      undefined,
      { kind: 'local' },
      expect.objectContaining({
        recoveredDocument: { originalPath: '/removed/a.ts', content: '' }
      })
    )
    const opened = mocks.state.openFile.mock.calls[0]?.[0]
    expect(opened.filePath).toBe('/active/a (recovered).ts')
    expect(opened.isUntitled).toBe(true)
    expect(opened).not.toHaveProperty('lastKnownDiskSignature')
    expect(opened).not.toHaveProperty('externalSshTargetId')
    expect(opened).not.toHaveProperty('runtimeEnvironmentId')
  })

  it('uses the active destination host rather than the removed document host', async () => {
    mocks.context.mockReturnValue({ target: { kind: 'environment', environmentId: 'destination' } })
    await reopenClosedUnsavedFiles([closed()])
    expect(mocks.create.mock.calls[0]?.[3]).toEqual({
      kind: 'environment',
      environmentId: 'destination'
    })
  })

  it('takes the path from the active workspace’s owning host', async () => {
    await reopenClosedUnsavedFiles([closed()])
    expect(mocks.state.getKnownWorktreeById).toHaveBeenCalledWith('active-wt', 'ssh:active')
  })

  it('refuses when the owner route is not the active workspace’s host', async () => {
    mocks.capture.mockReturnValue({ generation: { route: { executionHostId: 'local' } } })
    expect(await reopenClosedUnsavedFiles([closed()])).toHaveLength(1)
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps the payload for retry when no workspace is active', async () => {
    mocks.state.activeWorktreeId = null
    showClosedUnsavedFilesToast([closed()], 'Feature work', 7)
    click()
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    expect(mocks.dismiss).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    mocks.state.activeWorktreeId = 'active-wt'
    click()
    await vi.waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('notice'))
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('retries only the documents that failed to create', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Offline'))
    showClosedUnsavedFilesToast(
      [closed(), closed({ filePath: '/removed/b.ts' })],
      'Feature work',
      7
    )
    click()
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(1))
    click()
    await vi.waitFor(() => expect(mocks.dismiss).toHaveBeenCalledTimes(1))
    expect(mocks.create).toHaveBeenCalledTimes(3)
    expect(mocks.create.mock.calls[2]?.[4].recoveredDocument.originalPath).toBe('/removed/a.ts')
  })

  it('releases the holder after Reopen even if the library retains the callbacks', async () => {
    showClosedUnsavedFilesToast([closed()], 'Feature work', 7)
    click()
    click()
    await vi.waitFor(() => expect(mocks.dismiss).toHaveBeenCalledTimes(1))
    click()
    notice().onDismiss()
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('shows one combined notice and releases text on dismissal', () => {
    showClosedUnsavedFilesToast(
      [closed(), closed({ filePath: '/removed/b.ts' })],
      'Feature work',
      7
    )
    expect(mocks.warning).toHaveBeenCalledWith(
      'Closed 2 files with unsaved edits from Feature work',
      expect.anything()
    )
    notice().onDismiss()
    notice().onDismiss()
    click()
    expect(mocks.create).not.toHaveBeenCalled()
    // The removed tabs' kept records go with the notice.
    expect(mocks.state.releaseKeptEditorBuffers).toHaveBeenCalledWith(7)
    expect(console.warn).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledWith(
      '[editor] dropped unsaved edits from a removed workspace',
      { filePaths: ['/removed/a.ts', '/removed/b.ts'] }
    )
  })
})
