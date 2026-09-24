import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelFrame, KernelFrameEvent } from '../../../../shared/notebook-kernel-types'

type Listener = (state: unknown, previous: unknown) => void

const { appStoreListeners, openFiles } = vi.hoisted(() => {
  const appStoreListeners: Listener[] = []
  const openFiles: { current: { filePath: string }[] } = { current: [] }
  return { appStoreListeners, openFiles }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: (listener: Listener) => appStoreListeners.push(listener)
  }
}))

const FILE = '/nb.ipynb'
const VENV = { path: '/proj/.venv/bin/python', name: '.venv', version: '3.12.1' }
let emitFrame: (event: KernelFrameEvent) => void = () => {}
const notebookApi = {
  listPythonEnvironments: vi.fn(),
  startKernel: vi.fn(),
  installIpykernel: vi.fn(),
  execute: vi.fn(),
  interrupt: vi.fn(),
  shutdownKernel: vi.fn(),
  onKernelFrame: vi.fn((callback: (event: KernelFrameEvent) => void) => {
    emitFrame = callback
    return () => {}
  })
}
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: { notebook: notebookApi } }
})

const session = await import('./ipynb-kernel-session')
const { getCellRun, getSession } = await import('./ipynb-kernel-store')

function frame(value: KernelFrame): void {
  emitFrame({ filePath: FILE, frame: value })
}

beforeEach(() => {
  vi.clearAllMocks()
  notebookApi.listPythonEnvironments.mockResolvedValue({ workspace: [VENV], path: [] })
  notebookApi.startKernel.mockResolvedValue({ status: 'ready' })
  // Closing the tab drops the session, giving each test a fresh one.
  openFiles.current = []
  for (const listener of appStoreListeners) {
    listener({ openFiles: openFiles.current }, { openFiles: [] })
  }
  openFiles.current = [{ filePath: FILE }]
})

describe('notebook kernel session', () => {
  it('starts the recommended env, runs queued cells in order, and stops the queue on an error', async () => {
    await session.runCells(
      FILE,
      [
        { key: 'a', code: 'x = 1' },
        { key: 'b', code: '1 / 0' },
        { key: 'c', code: 'x' }
      ],
      '/proj'
    )
    expect(notebookApi.startKernel).toHaveBeenCalledWith({ filePath: FILE, python: VENV.path })
    expect(notebookApi.execute).toHaveBeenCalledTimes(1)
    expect(notebookApi.execute).toHaveBeenLastCalledWith({ filePath: FILE, code: 'x = 1' })

    frame({ type: 'stream', content: { name: 'stdout', text: 'hi\n' } })
    frame({ type: 'done', status: 'ok', execution_count: 1 })
    expect(getCellRun(FILE, 'a')).toMatchObject({
      executionCount: 1,
      outputs: [{ output_type: 'stream', text: 'hi\n' }]
    })
    expect(notebookApi.execute).toHaveBeenLastCalledWith({ filePath: FILE, code: '1 / 0' })

    frame({ type: 'error', content: { ename: 'ZeroDivisionError', evalue: '', traceback: [] } })
    frame({ type: 'done', status: 'error', execution_count: 2 })
    expect(notebookApi.execute).toHaveBeenCalledTimes(2)
    expect(getCellRun(FILE, 'c')).toBeUndefined()
    expect(getCellRun(FILE, 'b')?.finishedAt).not.toBeNull()
  })

  it('reports a dead kernel in the running cell and drops the queue', async () => {
    await session.runCells(
      FILE,
      [
        { key: 'a', code: 'import os; os._exit(1)' },
        { key: 'b', code: 'x' }
      ],
      null
    )
    frame({ type: 'exit', detail: 'segfault' })
    const run = getCellRun(FILE, 'a')
    expect(run?.finishedAt).not.toBeNull()
    expect(JSON.stringify(run?.outputs)).toContain('The kernel died.')
    expect(JSON.stringify(run?.outputs)).toContain('segfault')
    expect(getCellRun(FILE, 'b')).toBeUndefined()
    expect(notebookApi.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps cells queued through a missing-ipykernel install, then runs them', async () => {
    notebookApi.startKernel.mockResolvedValueOnce({ status: 'missing-ipykernel' })
    notebookApi.installIpykernel.mockResolvedValue({ ok: true, detail: '' })
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    expect(notebookApi.execute).not.toHaveBeenCalled()

    await session.installIpykernel(FILE)
    expect(notebookApi.installIpykernel).toHaveBeenCalledWith({ python: VENV.path })
    expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'x' })
  })

  it('writes an install failure into the waiting cell', async () => {
    notebookApi.startKernel.mockResolvedValueOnce({ status: 'missing-ipykernel' })
    notebookApi.installIpykernel.mockResolvedValue({
      ok: false,
      detail: 'error: externally-managed-environment'
    })
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    await session.installIpykernel(FILE)
    const outputs = JSON.stringify(getCellRun(FILE, 'a')?.outputs)
    expect(outputs).toContain('externally-managed-environment')
    expect(outputs).toContain('Installing ipykernel failed')
  })

  it('falls back to Python on PATH when there is no workspace env', async () => {
    notebookApi.listPythonEnvironments.mockResolvedValue({ workspace: [], path: [VENV] })
    // A remembered env from an earlier test would skip discovery; use a fresh notebook.
    openFiles.current = [{ filePath: '/other.ipynb' }]
    await session.runCells('/other.ipynb', [{ key: 'a', code: 'x' }], null)
    expect(notebookApi.startKernel).toHaveBeenCalledWith({
      filePath: '/other.ipynb',
      python: VENV.path
    })
  })

  it('starts one kernel when a second run lands during discovery', async () => {
    openFiles.current = [{ filePath: '/third.ipynb' }]
    await Promise.all([
      session.runCells('/third.ipynb', [{ key: 'a', code: 'x' }], null),
      session.runCells('/third.ipynb', [{ key: 'b', code: 'y' }], null)
    ])
    expect(notebookApi.startKernel).toHaveBeenCalledOnce()
    expect(getSession('/third.ipynb').queue).toEqual([{ key: 'b', code: 'y' }])
  })

  it.each([
    ['discovery', '/fourth.ipynb', 'listPythonEnvironments'],
    ['startKernel', FILE, 'startKernel']
  ] as const)('recovers when %s rejects', async (_step, filePath, method) => {
    openFiles.current = [{ filePath }]
    notebookApi[method].mockRejectedValueOnce(new Error('not authorized'))
    await session.runCells(filePath, [{ key: 'a', code: 'x' }], null)
    expect(getSession(filePath)).toMatchObject({ status: 'off', queue: [] })
    expect(JSON.stringify(getCellRun(filePath, 'a')?.outputs)).toContain('not authorized')

    await session.runCells(filePath, [{ key: 'b', code: 'y' }], null)
    expect(notebookApi.execute).toHaveBeenCalledWith({ filePath, code: 'y' })
  })

  it('quotes the copyable install command only when the path needs it', () => {
    const posix = (path: string): string => session.ipykernelInstallCommand(path, false)
    const windows = (path: string): string => session.ipykernelInstallCommand(path, true)
    const pip = ' -m pip install -U ipykernel'
    expect(posix('/v/bin/python')).toBe(`'/v/bin/python'${pip}`)
    expect(posix('/my env/bin/python')).toBe(`'/my env/bin/python'${pip}`)
    expect(posix('/Dev&Test/bin/python')).toBe(`'/Dev&Test/bin/python'${pip}`)
    expect(posix("/Bob's/bin/python")).toBe(`'/Bob'\\''s/bin/python'${pip}`)
    expect(windows('C:\\My Env\\python.exe')).toBe(`& 'C:\\My Env\\python.exe'${pip}`)
    expect(windows('C:\\Dev&Test\\python.exe')).toBe(`& 'C:\\Dev&Test\\python.exe'${pip}`)
    expect(windows("C:\\Bob's\\python.exe")).toBe(`& 'C:\\Bob''s\\python.exe'${pip}`)
  })

  it('shuts the kernel down when the notebook tab closes', async () => {
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    for (const listener of appStoreListeners) {
      listener({ openFiles: [] }, { openFiles: openFiles.current })
    }
    expect(notebookApi.shutdownKernel).toHaveBeenCalledWith({ filePath: FILE })
    expect(getCellRun(FILE, 'a')).toBeUndefined()
  })

  it('offers a restart when an interrupt gets no answer', async () => {
    vi.useFakeTimers()
    try {
      await session.runCells(FILE, [{ key: 'a', code: 'while True: pass' }], null)
      session.interruptKernel(FILE)
      expect(notebookApi.interrupt).toHaveBeenCalledWith({ filePath: FILE })
      vi.advanceTimersByTime(9_000)
      expect(getSession(FILE).interruptStalled).toBe(false)
      vi.advanceTimersByTime(1_000)
      expect(getSession(FILE).interruptStalled).toBe(true)

      frame({ type: 'done', status: 'error', execution_count: 1 })
      expect(getSession(FILE).interruptStalled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
