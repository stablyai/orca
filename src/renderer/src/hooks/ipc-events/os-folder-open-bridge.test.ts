import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerOsFolderOpenBridge } from './os-folder-open-bridge'

const mocks = vi.hoisted(() => ({
  openModal: vi.fn(),
  toastError: vi.fn(),
  subscribe: vi.fn<(listener: () => void) => () => void>()
}))
let storeState: {
  workspaceSessionReady: boolean
  activeModal: string
  settings: { activeRuntimeEnvironmentId: string | null } | null
  openModal: typeof mocks.openModal
}
vi.mock('../../store', () => ({
  useAppStore: { getState: () => storeState, subscribe: mocks.subscribe }
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function stubPreload(ui: Record<string, unknown>): void {
  vi.stubGlobal('window', { api: { ui } })
}
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('registerOsFolderOpenBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscribe.mockReturnValue(() => {})
    storeState = {
      workspaceSessionReady: true,
      activeModal: 'none',
      settings: { activeRuntimeEnvironmentId: null },
      openModal: mocks.openModal
    }
    mocks.openModal.mockImplementation(() => {
      storeState.activeModal = 'add-repo'
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens a pending folder through the existing add-project modal', async () => {
    stubPreload({ consumePendingFolderOpens: () => Promise.resolve(['/projects/pending']) })
    registerOsFolderOpenBridge([])
    await settle()
    expect(mocks.openModal).toHaveBeenCalledExactlyOnceWith('add-repo', {
      droppedLocalPath: '/projects/pending'
    })
  })

  it('opens pushed folders and ignores duplicates in the queue', async () => {
    let receive: (paths: string[]) => void = () => {}
    stubPreload({
      onOpenFolders: (listener: typeof receive) => {
        receive = listener
      }
    })
    registerOsFolderOpenBridge([])
    receive(['/projects/live', '/projects/live'])
    await settle()
    storeState.activeModal = 'none'
    mocks.subscribe.mock.calls[0][0]()
    await settle()
    expect(mocks.openModal).toHaveBeenCalledExactlyOnceWith('add-repo', {
      droppedLocalPath: '/projects/live'
    })
  })

  it('waits for session readiness and modal dismissal, then drains on store changes', async () => {
    storeState.workspaceSessionReady = false
    storeState.activeModal = 'settings'
    stubPreload({ consumePendingFolderOpens: () => Promise.resolve(['/first', '/next']) })
    registerOsFolderOpenBridge([])
    await settle()
    expect(mocks.openModal).not.toHaveBeenCalled()
    storeState.workspaceSessionReady = true
    mocks.subscribe.mock.calls[0][0]()
    await settle()
    expect(mocks.openModal).not.toHaveBeenCalled()
    storeState.activeModal = 'none'
    mocks.subscribe.mock.calls[0][0]()
    await settle()
    expect(mocks.openModal).toHaveBeenLastCalledWith('add-repo', { droppedLocalPath: '/first' })
    storeState.activeModal = 'none'
    mocks.subscribe.mock.calls[0][0]()
    await settle()
    expect(mocks.openModal).toHaveBeenLastCalledWith('add-repo', { droppedLocalPath: '/next' })
    expect(mocks.openModal).toHaveBeenCalledTimes(2)
  })

  it('rejects local folders in a remote runtime', async () => {
    storeState.settings = { activeRuntimeEnvironmentId: 'remote' }
    stubPreload({ consumePendingFolderOpens: () => Promise.resolve(['/project']) })
    registerOsFolderOpenBridge([])
    await settle()
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith(
      'Use a host path to add projects from a remote host.'
    )
  })

  it.each([
    {},
    { consumePendingFolderOpens: () => Promise.reject(new Error('unavailable')) },
    { consumePendingFolderOpens: () => Promise.resolve(null) }
  ])('tolerates unavailable or mismatched preload APIs (%#)', async (ui) => {
    stubPreload(ui)
    expect(() => registerOsFolderOpenBridge([])).not.toThrow()
    await settle()
    expect(mocks.openModal).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('unsubscribes and ignores queued, pushed and pending work after disposal', async () => {
    const unsubscribeStore = vi.fn()
    const unsubscribePush = vi.fn()
    mocks.subscribe.mockReturnValue(unsubscribeStore)
    let receive: (paths: string[]) => void = () => {}
    let resolvePending: (paths: string[]) => void = () => {}
    stubPreload({
      onOpenFolders: (listener: typeof receive) => {
        receive = listener
        return unsubscribePush
      },
      consumePendingFolderOpens: () =>
        new Promise<string[]>((resolve) => {
          resolvePending = resolve
        })
    })
    const unsubs: (() => void)[] = []
    registerOsFolderOpenBridge(unsubs)
    receive(['/queued'])
    unsubs.forEach((unsubscribe) => unsubscribe())
    receive(['/pushed'])
    resolvePending(['/pending'])
    mocks.subscribe.mock.calls[0][0]()
    await settle()
    expect(unsubscribeStore).toHaveBeenCalledOnce()
    expect(unsubscribePush).toHaveBeenCalledOnce()
    expect(mocks.openModal).not.toHaveBeenCalled()
  })
})
