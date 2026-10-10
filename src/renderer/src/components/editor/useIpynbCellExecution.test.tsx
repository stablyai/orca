// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseIpynb } from './ipynb-parse'
import type { KernelFrameEvent } from '../../../../shared/notebook-kernel-types'

const { getConnectionIdMock, notebookApi, toastError, frameListener } = vi.hoisted(() => {
  const frameListener = { current: (_event: KernelFrameEvent): void => {} }
  const notebookApi = {
    listPythonEnvironments: vi.fn(),
    startKernel: vi.fn(),
    execute: vi.fn(),
    shutdownKernel: vi.fn(),
    onKernelFrame: vi.fn((listener: (event: KernelFrameEvent) => void) => {
      frameListener.current = listener
      return () => {}
    })
  }
  // The kernel session subscribes to kernel frames when it loads.
  Object.defineProperty(window, 'api', { configurable: true, value: { notebook: notebookApi } })
  return {
    getConnectionIdMock: vi.fn((): string | null => null),
    notebookApi,
    toastError: vi.fn(),
    frameListener
  }
})

vi.mock('@/lib/connection-context', () => ({ getConnectionId: getConnectionIdMock }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))

import { useIpynbCellExecution } from './useIpynbCellExecution'
import { runCells, trustNotebook } from './ipynb-kernel-session'
import { getSession } from './ipynb-kernel-store'

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

beforeEach(() => {
  vi.clearAllMocks()
  getConnectionIdMock.mockReturnValue(null)
  notebookApi.listPythonEnvironments.mockResolvedValue({
    workspace: [{ path: '/repo/.venv/bin/python', name: '.venv', version: '3.12.1' }],
    path: []
  })
  notebookApi.startKernel.mockResolvedValue({ status: 'ready' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('notebook cell execution', () => {
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

function completedNotebookContent(count: number): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' }, custom: { keep: true } },
    cells: Array.from({ length: count }, (_, index) => ({
      id: `cell-${index}`,
      cell_type: 'code',
      metadata: { tags: ['keep'] },
      execution_count: null,
      outputs: [],
      source: [`print(${index})\n`]
    }))
  })
}

async function finishHiddenRuns(filePath: string, count: number): Promise<void> {
  trustNotebook(filePath)
  await runCells(
    filePath,
    Array.from({ length: count }, (_, index) => ({
      key: `cell-${index}`,
      code: `print(${index})`
    })),
    '/repo'
  )
  for (let index = 0; index < count; index += 1) {
    frameListener.current({
      filePath,
      frame: { type: 'stream', content: { name: 'stdout', text: `α😀 ${index}\nsecond\n` } }
    })
    frameListener.current({
      filePath,
      frame: {
        type: 'display_data',
        content: {
          data: { 'text/plain': `result ${index}` },
          metadata: { keep: true },
          transient: { display_id: `display-${index}` }
        }
      }
    })
    frameListener.current({
      filePath,
      frame: { type: 'done', status: 'ok', execution_count: index + 1 }
    })
  }
}

function mountFinishedNotebook(filePath: string, content: string) {
  const applyContent = vi.fn()
  const flushSourceDrafts = vi.fn(() => content)
  const hook = renderHook(() =>
    useIpynbCellExecution({
      filePath,
      worktreeId: 'worktree-a',
      rootPath: '/repo',
      flushSourceDrafts,
      applyContent
    })
  )
  return { hook, applyContent, flushSourceDrafts }
}

describe('finished notebook runs retained while the viewer is hidden', () => {
  it('persists all completed outputs with one serialization when the viewer remounts', async () => {
    const filePath = '/repo/hidden-batch.ipynb'
    const content = completedNotebookContent(20)
    await finishHiddenRuns(filePath, 20)
    expect(Object.values(getSession(filePath).runs).every((run) => !run.committed)).toBe(true)
    const serialize = vi.spyOn(JSON, 'stringify')
    const { hook, applyContent, flushSourceDrafts } = mountFinishedNotebook(filePath, content)
    expect(serialize).toHaveBeenCalledTimes(1)
    serialize.mockRestore()
    expect(flushSourceDrafts).toHaveBeenCalledTimes(1)
    expect(applyContent).toHaveBeenCalledTimes(1)
    const saved: unknown = applyContent.mock.calls[0]?.[0]
    expect(typeof saved).toBe('string')
    if (typeof saved !== 'string') {
      throw new Error('Expected saved notebook text')
    }
    const cells = parseIpynb(saved).cells
    expect(cells).toHaveLength(20)
    for (let index = 0; index < cells.length; index += 1) {
      expect(cells[index]?.executionCount).toBe(index + 1)
      expect(cells[index]?.outputs[0]).toEqual({
        kind: 'stream',
        name: 'stdout',
        text: `α😀 ${index}\nsecond\n`
      })
      expect(cells[index]?.outputs[1]).toMatchObject({
        kind: 'display',
        items: [{ mime: 'text/plain', value: `result ${index}` }]
      })
    }
    expect(saved).toContain('"custom"')
    expect(saved).toContain('"tags"')
    expect(saved).not.toContain('"transient"')
    expect(
      Object.values(getSession(filePath).runs).every(
        (run) => run.committed && run.outputs.length === 0
      )
    ).toBe(true)
    hook.unmount()
  })

  it('preserves the saved prefix when a later raw cell refuses the update and retires every run', async () => {
    const filePath = '/repo/hidden-refused-middle.ipynb'
    const content = completedNotebookContent(3)
    const raw: unknown = JSON.parse(content)
    if (typeof raw !== 'object' || raw === null || !('cells' in raw) || !Array.isArray(raw.cells)) {
      throw new Error('Expected notebook cells')
    }
    raw.cells.splice(1, 0, null)
    await finishHiddenRuns(filePath, 3)
    const { hook, applyContent } = mountFinishedNotebook(filePath, JSON.stringify(raw))
    expect(applyContent).toHaveBeenCalledTimes(1)
    const saved: unknown = applyContent.mock.calls[0]?.[0]
    if (typeof saved !== 'string') {
      throw new Error('Expected saved prefix')
    }
    const cells = parseIpynb(saved).cells
    expect(cells.map((cell) => cell.executionCount)).toEqual([1, null, null])
    expect(cells.map((cell) => cell.outputs.length)).toEqual([2, 0, 0])
    expect(
      Object.values(getSession(filePath).runs).every(
        (run) => run.committed && run.outputs.length === 0
      )
    ).toBe(true)
    hook.unmount()
  })

  it.each(['{', '{"cells":[null,{"id":"cell-0","cell_type":"code","source":[]}]}'])(
    'retires runs without changing a document that refuses its first update: %s',
    async (content) => {
      const filePath = `/repo/hidden-refused-first-${content}.ipynb`
      await finishHiddenRuns(filePath, 1)
      const { hook, applyContent } = mountFinishedNotebook(filePath, content)
      expect(applyContent).not.toHaveBeenCalled()
      expect(getSession(filePath).runs['cell-0']).toMatchObject({ committed: true, outputs: [] })
      hook.unmount()
    }
  )
})
