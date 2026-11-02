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
  startKernel: vi.fn<() => Promise<KernelStartResult>>(),
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

function finishFreshCell(): void {
  emitFrame({
    filePath: FILE,
    frame: { type: 'stream', content: { name: 'stdout', text: 'fresh output\n' } }
  })
  emitFrame({
    filePath: FILE,
    frame: { type: 'done', status: 'ok', execution_count: 1 }
  })
}

beforeEach(() => {
  closeNotebook()
  store.setState({ environments: {} })
  vi.clearAllMocks()
  notebookApi.startKernel.mockReset().mockResolvedValue({ status: 'ready' })
  notebookApi.listPythonEnvironments.mockReset().mockResolvedValue({
    workspace: [ENVIRONMENT],
    path: []
  })
  reopenNotebook()
})

afterEach(() => closeNotebook())

describe('notebook start request session ownership', () => {
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
      closeNotebook()
      reopenNotebook()
      const fresh = session.runCells(FILE, [{ key: 'fresh', code: 'fresh cell' }], null)
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
