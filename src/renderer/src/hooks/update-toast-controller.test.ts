import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createUpdateToastController } from './update-toast-controller'

function createToastApi() {
  return {
    loading: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}

function createUpdaterApi() {
  return {
    download: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn().mockResolvedValue(undefined)
  }
}

function createStoreApi(dismissedVersion: string | null = null) {
  return {
    getDismissedVersion: vi.fn().mockReturnValue(dismissedVersion),
    dismissUpdate: vi.fn()
  }
}

function getInfoOptions(toastApi: ReturnType<typeof createToastApi>) {
  const lastCall = toastApi.info.mock.calls.at(-1) as [string, Record<string, unknown>]
  const [, options] = lastCall
  return options
}

describe('createUpdateToastController', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows a single persistent available toast with release notes and update action', () => {
    const toastApi = createToastApi()
    toastApi.loading.mockReturnValue('checking-toast')
    toastApi.info.mockReturnValue('available-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'checking', userInitiated: true })
    controller.handleStatus({
      state: 'available',
      version: '1.2.3',
      releaseUrl: 'https://example.com/release/1.2.3'
    })

    expect(toastApi.loading).toHaveBeenCalledWith('Checking for updates...')
    expect(toastApi.dismiss).toHaveBeenCalledWith('checking-toast')
    expect(toastApi.info).toHaveBeenCalledTimes(1)
    expect(toastApi.success).not.toHaveBeenCalled()

    const options = getInfoOptions(toastApi)
    expect(options.duration).toBe(Infinity)
    expect((options.description as { props: { href: string } }).props.href).toBe(
      'https://example.com/release/1.2.3'
    )
    expect((options.action as { label: string }).label).toBe('Update')
  })

  it('dismisses the available toast when download progress starts', () => {
    const toastApi = createToastApi()
    toastApi.info.mockReturnValue('available-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.2.3' })
    controller.handleStatus({ state: 'downloading', version: '1.2.3', percent: 42 })

    expect(toastApi.dismiss).toHaveBeenCalledWith('available-toast')
    expect(toastApi.loading).toHaveBeenLastCalledWith('Downloading v1.2.3… 42%', {
      id: 'update-download-progress',
      duration: Infinity
    })
  })

  it('auto-restarts after download only when the user clicked the one-click update action', async () => {
    const toastApi = createToastApi()
    toastApi.info.mockReturnValue('available-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.2.3' })
    const infoOptions = getInfoOptions(toastApi)
    ;(infoOptions.action as { onClick: () => void }).onClick()

    expect(updaterApi.download).toHaveBeenCalledTimes(1)

    controller.handleStatus({ state: 'downloaded', version: '1.2.3' })

    expect(updaterApi.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(toastApi.success).not.toHaveBeenCalled()
  })

  it('clears stale one-click restart intent after a later check error', () => {
    const toastApi = createToastApi()
    toastApi.info.mockReturnValue('available-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.2.3' })
    const infoOptions = getInfoOptions(toastApi)
    ;(infoOptions.action as { onClick: () => void }).onClick()

    controller.handleStatus({ state: 'error', message: 'network timeout' })
    controller.handleStatus({ state: 'downloaded', version: '1.2.4' })

    expect(updaterApi.quitAndInstall).not.toHaveBeenCalled()
    expect(toastApi.success).toHaveBeenCalledWith('Version 1.2.4 is ready to install.', {
      description: expect.any(Object),
      duration: Infinity,
      action: expect.objectContaining({ label: 'Restart Now' })
    })
  })

  it('replaces the checking toast with a latest-version success toast for user-initiated checks', () => {
    const toastApi = createToastApi()
    toastApi.loading.mockReturnValue('checking-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'checking', userInitiated: true })
    controller.handleStatus({ state: 'not-available', userInitiated: true })

    expect(toastApi.success).toHaveBeenCalledWith("You're on the latest version.", {
      id: 'checking-toast'
    })
  })

  it('suppresses the available toast when the version matches the dismissed version', () => {
    const toastApi = createToastApi()
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi('1.2.3')
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.2.3' })

    expect(toastApi.info).not.toHaveBeenCalled()
  })

  it('shows the available toast when a newer version supersedes the dismissed one', () => {
    const toastApi = createToastApi()
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi('1.2.3')
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.3.0' })

    expect(toastApi.info).toHaveBeenCalledTimes(1)
  })

  it('replaces checking toast with an unable-to-check message when a user-initiated check goes idle', () => {
    const toastApi = createToastApi()
    toastApi.loading.mockReturnValue('checking-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'checking', userInitiated: true })
    controller.handleStatus({ state: 'idle' })

    expect(toastApi.info).toHaveBeenCalledWith(
      "Unable to check for updates right now. We'll try again shortly.",
      { id: 'checking-toast' }
    )
  })

  it('does not show a rolling-out message for background checks that go idle', () => {
    const toastApi = createToastApi()
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'checking' })
    controller.handleStatus({ state: 'idle' })

    expect(toastApi.info).not.toHaveBeenCalled()
  })

  it('calls dismissUpdate when the user closes the available toast without updating', () => {
    const toastApi = createToastApi()
    toastApi.info.mockReturnValue('available-toast')
    const updaterApi = createUpdaterApi()
    const storeApi = createStoreApi()
    const controller = createUpdateToastController({ toastApi, updaterApi, storeApi })

    controller.handleStatus({ state: 'available', version: '1.2.3' })
    const options = getInfoOptions(toastApi)
    ;(options.onDismiss as () => void)()

    expect(storeApi.dismissUpdate).toHaveBeenCalledTimes(1)
  })
})
