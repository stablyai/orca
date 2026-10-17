import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type {
  KernelFrameEvent,
  KernelStartResult,
  PythonEnvironments
} from '../../../../shared/notebook-kernel-types'

type OpenFilesState = { openFiles: { filePath: string }[] }
type AppStoreListener = (state: OpenFilesState, previous: OpenFilesState) => void

const { appStoreListeners } = vi.hoisted(() => {
  const appStoreListeners: AppStoreListener[] = []
  return { appStoreListeners }
})

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/store', () => ({
  useAppStore: {
    subscribe: (listener: AppStoreListener) => {
      appStoreListeners.push(listener)
      return () => {
        const index = appStoreListeners.indexOf(listener)
        if (index !== -1) {
          appStoreListeners.splice(index, 1)
        }
      }
    }
  }
}))

const FILE = '/notebook.ipynb'
const ENVIRONMENT = { path: '/workspace/.venv/bin/python', name: '.venv' }
let emitFrame: (event: KernelFrameEvent) => void = () => {}
const notebookApi = {
  listPythonEnvironments: vi.fn<() => Promise<PythonEnvironments>>(),
  startKernel:
    vi.fn<
      (_args: {
        filePath: string
        python: string
        producerId: string
      }) => Promise<KernelStartResult>
    >(),
  execute: vi.fn(),
  shutdownKernel: vi.fn(),
  onKernelFrame: (listener: (event: KernelFrameEvent) => void) => {
    emitFrame = listener
    return () => {}
  }
}
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: { notebook: notebookApi } }
})

const session = await import('./ipynb-kernel-session')
const { getSession, setEnvironment, store } = await import('./ipynb-kernel-store')

function closeNotebook(): void {
  for (const listener of appStoreListeners) {
    listener({ openFiles: [] }, { openFiles: [{ filePath: FILE }] })
  }
}

function reopenNotebook(): void {
  session.trustNotebook(FILE)
  setEnvironment(FILE, ENVIRONMENT)
}

function currentProducerId(): string {
  const call = notebookApi.startKernel.mock.lastCall
  if (!call) {
    throw new Error('Expected a kernel start')
  }
  return call[0].producerId
}

function finishFreshCell(): void {
  const producerId = currentProducerId()
  emitFrame({
    filePath: FILE,
    producerId,
    frame: {
      type: 'outputs',
      outputs: [{ type: 'stream', content: { name: 'stdout', text: 'fresh output\n' } }]
    }
  })
  emitFrame({
    filePath: FILE,
    producerId,
    frame: { type: 'done', status: 'ok', execution_count: 1 }
  })
}

beforeEach(() => {
  closeNotebook()
  store.setState({ environments: {} })
  vi.clearAllMocks()
  notebookApi.startKernel.mockReset().mockResolvedValue({ status: 'ready' })
  notebookApi.shutdownKernel.mockReset().mockResolvedValue(undefined)
  notebookApi.listPythonEnvironments.mockReset().mockResolvedValue({
    workspace: [ENVIRONMENT],
    path: []
  })
  reopenNotebook()
})

afterEach(() => closeNotebook())

describe('notebook start request session ownership', () => {
  it.each(['ready', 'failed', 'missing', 'rejected'] as const)(
    'keeps replacement work while a draining start resolves %s',
    async (outcome) => {
      const oldReply = Promise.withResolvers<KernelStartResult>()
      notebookApi.startKernel.mockReturnValueOnce(oldReply.promise)
      const old = session.runCells(FILE, [{ key: 'old', code: 'old cell' }], null)
      const producerId = currentProducerId()
      session.restartKernel(FILE)
      await session.runCells(FILE, [{ key: 'new', code: 'new cell' }], null)
      if (outcome === 'rejected') {
        oldReply.reject(new Error('old failed'))
      } else {
        oldReply.resolve(
          outcome === 'missing'
            ? { status: 'missing-ipykernel', externallyManaged: false }
            : outcome === 'failed'
              ? { status: 'failed', detail: 'old failed' }
              : { status: 'ready' }
        )
      }
      await old
      expect(getSession(FILE)).toMatchObject({
        status: 'starting',
        queue: [{ key: 'new', code: 'new cell' }],
        setup: null
      })
      expect(notebookApi.execute).not.toHaveBeenCalled()
      emitFrame({ filePath: FILE, producerId, frame: { type: 'stopped' } })
      await vi.waitFor(() =>
        expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'new cell' })
      )
    }
  )

  it('keeps the chosen interpreter when old discovery resolves during drain', async () => {
    const discovery = Promise.withResolvers<PythonEnvironments>()
    store.setState({ environments: {} })
    notebookApi.listPythonEnvironments.mockReturnValueOnce(discovery.promise)
    const old = session.runCells(FILE, [{ key: 'old', code: 'old cell' }], '/workspace')
    session.selectEnvironment(FILE, ENVIRONMENT)
    discovery.resolve({ workspace: [{ path: '/old/python', name: 'old' }], path: [] })
    await old
    expect(store.getState().environments[FILE]).toEqual(ENVIRONMENT)
    expect(notebookApi.startKernel).not.toHaveBeenCalled()
    const producerId = notebookApi.shutdownKernel.mock.lastCall?.[0].producerId
    emitFrame({ filePath: FILE, producerId, frame: { type: 'stopped' } })
    await vi.waitFor(() =>
      expect(notebookApi.startKernel).toHaveBeenCalledWith({
        filePath: FILE,
        python: ENVIRONMENT.path,
        producerId: expect.any(String)
      })
    )
  })

  it.each([
    ['ready', false],
    ['ready', true],
    ['failed', false],
    ['failed', true],
    ['missing', false],
    ['missing', true],
    ['rejected', false],
    ['rejected', true]
  ] as const)(
    'ignores old %s completion when replacement ready first is %s',
    async (oldOutcome, freshReadyFirst) => {
      const oldReply = Promise.withResolvers<KernelStartResult>()
      const freshReply = Promise.withResolvers<KernelStartResult>()
      notebookApi.startKernel
        .mockReturnValueOnce(oldReply.promise)
        .mockReturnValueOnce(freshReply.promise)
      const old = session.runCells(FILE, [{ key: 'old', code: 'old cell' }], null)
      const oldProducerId = currentProducerId()
      closeNotebook()
      reopenNotebook()
      const fresh = session.runCells(FILE, [{ key: 'fresh', code: 'fresh cell' }], null)
      emitFrame({
        filePath: FILE,
        producerId: oldProducerId,
        frame: {
          type: 'outputs',
          outputs: [{ type: 'stream', content: { name: 'stdout', text: 'stale' } }]
        }
      })
      emitFrame({
        filePath: FILE,
        producerId: oldProducerId,
        frame: { type: 'done', status: 'error', execution_count: 1 }
      })
      emitFrame({
        filePath: FILE,
        producerId: oldProducerId,
        frame: { type: 'exit', detail: 'stale death' }
      })
      emitFrame({ filePath: FILE, producerId: oldProducerId, frame: { type: 'stopped' } })
      if (freshReadyFirst) {
        freshReply.resolve({ status: 'ready' })
        await fresh
        finishFreshCell()
      }
      const expected = structuredClone(getSession(FILE))
      if (oldOutcome === 'rejected') {
        oldReply.reject(new Error('Old start rejected'))
      } else {
        oldReply.resolve(
          oldOutcome === 'ready'
            ? { status: 'ready' }
            : oldOutcome === 'missing'
              ? { status: 'missing-ipykernel', externallyManaged: true }
              : { status: 'failed', detail: 'Old start failed' }
        )
      }
      await old

      expect(getSession(FILE)).toEqual(expected)
      expect(store.getState().environments[FILE]).toEqual(ENVIRONMENT)
      expect(notebookApi.execute).toHaveBeenCalledTimes(freshReadyFirst ? 1 : 0)
      expect(toast.error).not.toHaveBeenCalled()
      if (!freshReadyFirst) {
        freshReply.resolve({ status: 'ready' })
        await fresh
        finishFreshCell()
      }
      expect(notebookApi.execute).toHaveBeenCalledOnce()
      expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'fresh cell' })
      expect(getSession(FILE)).toMatchObject({
        status: 'ready',
        setup: null,
        queue: [],
        runs: { fresh: { outputs: [{ output_type: 'stream', text: 'fresh output\n' }] } }
      })
    }
  )

  it.each([false, true])(
    'ignores old discovery when replacement ready first is %s',
    async (freshReadyFirst) => {
      const discovered = Promise.withResolvers<PythonEnvironments>()
      const freshReply = Promise.withResolvers<KernelStartResult>()
      store.setState({ environments: {} })
      notebookApi.listPythonEnvironments.mockReturnValueOnce(discovered.promise)
      const old = session.runCells(FILE, [{ key: 'old', code: 'old cell' }], '/workspace')
      closeNotebook()
      reopenNotebook()
      notebookApi.startKernel.mockReturnValueOnce(freshReply.promise)
      const fresh = session.runCells(FILE, [{ key: 'fresh', code: 'fresh cell' }], null)
      if (freshReadyFirst) {
        freshReply.resolve({ status: 'ready' })
        await fresh
        finishFreshCell()
      }
      const expected = structuredClone(getSession(FILE))
      discovered.resolve({
        workspace: [{ path: '/obsolete/bin/python', name: 'obsolete' }],
        path: []
      })
      await old

      expect(getSession(FILE)).toEqual(expected)
      expect(store.getState().environments[FILE]).toEqual(ENVIRONMENT)
      expect(notebookApi.startKernel).toHaveBeenCalledOnce()
      expect(toast.error).not.toHaveBeenCalled()
      if (!freshReadyFirst) {
        freshReply.resolve({ status: 'ready' })
        await fresh
        finishFreshCell()
      }
      expect(notebookApi.execute).toHaveBeenCalledOnce()
      expect(notebookApi.execute).toHaveBeenCalledWith({ filePath: FILE, code: 'fresh cell' })
    }
  )
})
