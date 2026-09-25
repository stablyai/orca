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
  createVenv: vi.fn(),
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
    notebookApi.startKernel.mockResolvedValueOnce({
      status: 'missing-ipykernel',
      externallyManaged: false
    })
    notebookApi.installIpykernel.mockResolvedValue({ ok: true, detail: '' })
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    expect(getSession(FILE).setup).toMatchObject({ base: VENV, offer: 'install', phase: 'idle' })
    // A second run while the dialog is open waits too.
    await session.runCells(FILE, [{ key: 'b', code: 'y' }], null)
    expect(notebookApi.startKernel).toHaveBeenCalledOnce()

    await session.installIpykernel(FILE)
    expect(notebookApi.installIpykernel).toHaveBeenCalledWith({ python: VENV.path })
    expect(getSession(FILE).setup).toBeNull()
    expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'x' })
  })

  it('keeps the dialog open with the install error and the cells still waiting', async () => {
    notebookApi.startKernel.mockResolvedValueOnce({
      status: 'missing-ipykernel',
      externallyManaged: false
    })
    notebookApi.installIpykernel.mockResolvedValue({ ok: false, detail: 'network unreachable' })
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    await session.installIpykernel(FILE)
    expect(getSession(FILE)).toMatchObject({
      setup: { phase: 'idle', error: 'network unreachable' },
      queue: [{ key: 'a', code: 'x' }]
    })

    session.cancelSetup(FILE)
    expect(getSession(FILE)).toMatchObject({ status: 'off', setup: null, queue: [] })
  })

  it('creates a .venv for a pip-locked Python and runs the waiting cells in it', async () => {
    const created = { path: '/repo/.venv/bin/python', name: '.venv', version: '3.14.0' }
    const system = { path: '/opt/homebrew/bin/python3', name: 'python3', version: '3.14.0' }
    openFiles.current = [{ filePath: '/repo/nb.ipynb' }]
    notebookApi.listPythonEnvironments.mockResolvedValue({ workspace: [], path: [system] })
    notebookApi.startKernel.mockResolvedValueOnce({
      status: 'missing-ipykernel',
      externallyManaged: true
    })
    notebookApi.createVenv.mockResolvedValue({ ok: true, environment: created })
    await session.runCells('/repo/nb.ipynb', [{ key: 'a', code: 'x' }], '/repo')
    expect(getSession('/repo/nb.ipynb').setup).toMatchObject({ base: system, offer: 'venv' })

    await session.createVirtualEnvironment('/repo/nb.ipynb', '/repo')
    expect(notebookApi.createVenv).toHaveBeenCalledWith({
      filePath: '/repo/nb.ipynb',
      rootPath: '/repo',
      python: system.path
    })
    expect(notebookApi.startKernel).toHaveBeenLastCalledWith({
      filePath: '/repo/nb.ipynb',
      python: created.path
    })
    expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: '/repo/nb.ipynb', code: 'x' })
  })

  it('switches a running notebook to a venv made from the picker, keeping it on failure', async () => {
    const created = { path: '/repo/.venv/bin/python', name: '.venv', version: '3.14.0' }
    const system = { path: '/usr/bin/python3', name: 'python3', version: '3.14.0' }
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    frame({ type: 'done', status: 'ok', execution_count: 1 })

    session.offerVirtualEnvironment(FILE, system)
    notebookApi.createVenv.mockResolvedValueOnce({ ok: false, detail: 'no ensurepip' })
    await session.createVirtualEnvironment(FILE, null)
    expect(getSession(FILE)).toMatchObject({ status: 'ready', setup: { error: 'no ensurepip' } })
    expect(notebookApi.startKernel).toHaveBeenCalledOnce()

    notebookApi.createVenv.mockResolvedValueOnce({ ok: true, environment: created })
    await session.createVirtualEnvironment(FILE, null)
    expect(notebookApi.startKernel).toHaveBeenLastCalledWith({
      filePath: FILE,
      python: created.path
    })
    expect(getSession(FILE)).toMatchObject({ status: 'ready', setup: null })
  })

  it('closes the setup prompt when another Python is picked, and runs the cells there', async () => {
    const other = { path: '/other/bin/python', name: 'other', version: '3.13.0' }
    notebookApi.startKernel.mockResolvedValueOnce({
      status: 'missing-ipykernel',
      externallyManaged: false
    })
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    session.selectEnvironment(FILE, other)
    expect(getSession(FILE).setup).toBeNull()
    await vi.waitFor(() => expect(getSession(FILE).status).toBe('ready'))
    expect(notebookApi.startKernel).toHaveBeenLastCalledWith({ filePath: FILE, python: other.path })
    expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'x' })
  })

  it('drops an install result once its tab has closed and reopened', async () => {
    notebookApi.startKernel.mockResolvedValueOnce({
      status: 'missing-ipykernel',
      externallyManaged: false
    })
    let finish: (value: { ok: boolean; detail: string }) => void = () => {}
    notebookApi.installIpykernel.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    await session.runCells(FILE, [{ key: 'a', code: 'x' }], null)
    const install = session.installIpykernel(FILE)
    for (const listener of appStoreListeners) {
      listener({ openFiles: [] }, { openFiles: openFiles.current })
    }
    finish({ ok: false, detail: 'late' })
    await install
    expect(getSession(FILE).setup).toBeNull()
    expect(notebookApi.startKernel).toHaveBeenCalledOnce()
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
