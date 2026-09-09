// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIpynb } from './ipynb-parse'

const { getConnectionIdMock } = vi.hoisted(() => ({
  getConnectionIdMock: vi.fn(() => 'ssh-connection')
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: getConnectionIdMock
}))

import { useIpynbCellExecution } from './useIpynbCellExecution'

function notebookContent(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'setup',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ['x = 41']
      },
      {
        id: 'run',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: ['print(x + 1)']
      }
    ]
  })
}

describe('notebook cell execution lifecycle', () => {
  const runPythonCell = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    runPythonCell.mockResolvedValue({ stdout: '42\n', stderr: '', exitCode: 0 })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { notebook: { runPythonCell } }
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'api')
  })

  it('requires file trust, saves first, and routes execution through the connection', async () => {
    const content = notebookContent()
    const onSave = vi.fn().mockResolvedValue(true)
    const applyContent = vi.fn()
    const { result } = renderHook(() =>
      useIpynbCellExecution({
        filePath: '/repo/notebook.ipynb',
        worktreeId: 'worktree-a',
        flushSourceDrafts: () => content,
        applyContent,
        onSave
      })
    )

    await act(() => result.current.runCell(1))
    expect(result.current.pendingRunCellIndex).toBe(1)
    expect(onSave).not.toHaveBeenCalled()
    expect(runPythonCell).not.toHaveBeenCalled()

    act(() => result.current.confirmPendingRun())
    await waitFor(() => expect(runPythonCell).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith(content)
    expect(runPythonCell).toHaveBeenCalledWith({
      filePath: '/repo/notebook.ipynb',
      code: 'print(x + 1)',
      preamble: 'x = 41',
      connectionId: 'ssh-connection'
    })
    await waitFor(() => expect(applyContent).toHaveBeenCalledOnce())
    expect(
      parseIpynb(applyContent.mock.calls[0]?.[0] as string).cells[1]?.outputs[0]
    ).toMatchObject({
      kind: 'stream',
      text: '42\n'
    })
  })

  it('drops stale trust prompts across file moves and skips execution after a failed save', async () => {
    const content = notebookContent()
    const onSave = vi.fn().mockResolvedValue(false)
    const hook = renderHook(
      ({ filePath }: { filePath: string }) =>
        useIpynbCellExecution({
          filePath,
          worktreeId: 'worktree-a',
          flushSourceDrafts: () => content,
          applyContent: vi.fn(),
          onSave
        }),
      { initialProps: { filePath: '/repo/a.ipynb' } }
    )

    await act(() => hook.result.current.runCell(1))
    expect(hook.result.current.pendingRunCellIndex).toBe(1)
    hook.rerender({ filePath: '/repo/b.ipynb' })
    expect(hook.result.current.pendingRunCellIndex).toBeNull()
    hook.rerender({ filePath: '/repo/a.ipynb' })
    expect(hook.result.current.pendingRunCellIndex).toBeNull()

    await act(() => hook.result.current.runCell(1, { skipTrustPrompt: true }))
    expect(onSave).toHaveBeenCalledWith(content)
    expect(runPythonCell).not.toHaveBeenCalled()
  })
})
