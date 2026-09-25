// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIpynb } from './ipynb-parse'

const { getConnectionIdMock, notebookApi, toastError } = vi.hoisted(() => {
  const notebookApi = {
    listPythonEnvironments: vi.fn(),
    startKernel: vi.fn(),
    execute: vi.fn(),
    shutdownKernel: vi.fn(),
    onKernelFrame: vi.fn(() => () => {})
  }
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook: notebookApi } })
  return {
    getConnectionIdMock: vi.fn((): string | null => null),
    notebookApi,
    toastError: vi.fn()
  }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionId: getConnectionIdMock }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

import { useIpynbCellExecution } from './useIpynbCellExecution'

function notebookContent(withIds: boolean): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: withIds ? 5 : 4,
    metadata: { language_info: { name: 'python' } },
    cells: [
      { ...(withIds ? { id: 'md' } : {}), cell_type: 'markdown', metadata: {}, source: ['# hi'] },
      {
        ...(withIds ? { id: 'run' } : {}),
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ['print(42)']
      }
    ]
  })
}

function renderExecution(filePath: string, applyContent = vi.fn(), withIds = true) {
  let content = notebookContent(withIds)
  applyContent.mockImplementation((next: string) => {
    content = next
  })
  const hook = renderHook(() =>
    useIpynbCellExecution({
      filePath,
      worktreeId: 'worktree-a',
      rootPath: '/repo',
      flushSourceDrafts: () => content,
      applyContent
    })
  )
  return { hook, applyContent, content: () => content }
}

describe('notebook cell execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConnectionIdMock.mockReturnValue(null)
    notebookApi.listPythonEnvironments.mockResolvedValue({
      workspace: [{ path: '/repo/.venv/bin/python', name: '.venv', version: '3.12.1' }],
      path: []
    })
    notebookApi.startKernel.mockResolvedValue({ status: 'ready' })
  })

  it('asks for trust before running, then runs the cell in a kernel', async () => {
    const { hook } = renderExecution('/repo/trust.ipynb')

    act(() => hook.result.current.runCell(1))
    expect(hook.result.current.pendingRun).toEqual([{ key: 'run', code: 'print(42)' }])
    expect(notebookApi.startKernel).not.toHaveBeenCalled()

    act(() => hook.result.current.confirmPendingRun())
    await waitFor(() =>
      expect(notebookApi.execute).toHaveBeenCalledWith({
        filePath: '/repo/trust.ipynb',
        code: 'print(42)'
      })
    )
    expect(notebookApi.startKernel).toHaveBeenCalledWith({
      filePath: '/repo/trust.ipynb',
      python: '/repo/.venv/bin/python'
    })
  })

  it('refuses to run in SSH workspaces without touching the notebook or starting a kernel', () => {
    getConnectionIdMock.mockReturnValue('ssh-connection')
    const { hook, applyContent } = renderExecution('/remote/notebook.ipynb')

    act(() => hook.result.current.runCell(1))
    expect(toastError).toHaveBeenCalledWith(
      'Notebook cells can only run for files on this computer.'
    )
    expect(applyContent).not.toHaveBeenCalled()
    expect(hook.result.current.pendingRun).toBeNull()
    expect(notebookApi.startKernel).not.toHaveBeenCalled()
  })

  it('gives id-less cells ids before queueing, so output follows a moved cell', () => {
    const { hook, content } = renderExecution('/repo/legacy.ipynb', vi.fn(), false)

    act(() => hook.result.current.runCell(1))
    const [cell] = hook.result.current.pendingRun ?? []
    const { cells } = parseIpynb(content())
    expect(cells[1]?.id).toBeTruthy()
    expect(cell?.key).toBe(cells[1]?.id)
  })
})
