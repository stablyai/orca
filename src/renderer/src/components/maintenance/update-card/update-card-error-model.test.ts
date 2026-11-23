import { describe, expect, it, vi } from 'vitest'
import { buildUpdateCardErrorModel } from './update-card-error-model'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'

const version = '1.4.273'
const checkpointError = 'Failed to persist renderer state before unload.'

function buildErrorCard(status: UpdateStatus, installError: string | null = null) {
  const quit = vi.fn()
  const retry = vi.fn()
  const model = buildUpdateCardErrorModel(
    {
      status,
      cachedVersion: version,
      installError,
      isLocalBuild: false,
      compatibilityRelaunching: false,
      compatibilitySetupError: null,
      onChooseLocalBuild: vi.fn(),
      onEnableHttp1Compatibility: vi.fn(),
      onRetryDownload: vi.fn(),
      onRecheck: vi.fn(),
      onInstallRetry: retry,
      onQuitToInstall: quit
    },
    (_key, fallback) => fallback
  )
  return { model, quit, retry }
}

describe('update restart recovery', () => {
  it('offers normal quit for a staged update after renderer checkpoint failure', () => {
    const { model, quit } = buildErrorCard(
      { state: 'downloaded', version, installOnQuit: true },
      checkpointError
    )

    expect(model).toMatchObject({ variant: 'waiting', detail: checkpointError })
    expect(model?.releaseUrl).toBeUndefined()
    model?.primaryAction?.onClick()
    expect(quit).toHaveBeenCalledWith(version)
  })

  it('offers normal quit after main-process preparation fails with the installer staged', () => {
    const { model, quit } = buildErrorCard({
      state: 'error',
      version,
      installOnQuit: true,
      retryAction: 'install',
      message: 'Could not prepare the session for restart.'
    })

    expect(model?.deferLabel).toBeTruthy()
    expect(model?.releaseUrl).toBeUndefined()
    model?.primaryAction?.onClick()
    expect(quit).toHaveBeenCalledWith(version)
  })

  it('retries a retained download on hosts without install-on-quit', () => {
    const { model, quit, retry } = buildErrorCard({ state: 'downloaded', version }, checkpointError)

    expect(model?.releaseUrl).toBeUndefined()
    model?.primaryAction?.onClick()
    expect(retry).toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
  })

  it('retries main-process preparation without downloading again on other platforms', () => {
    const { model, retry } = buildErrorCard({
      state: 'error',
      version,
      retryAction: 'install',
      message: 'Could not prepare the session for restart.'
    })

    expect(model?.releaseUrl).toBeUndefined()
    model?.primaryAction?.onClick()
    expect(retry).toHaveBeenCalled()
  })

  it('keeps the release link when the download itself fails', () => {
    const { model } = buildErrorCard({ state: 'error', version, message: 'Download failed.' })

    expect(model?.releaseUrl).toMatch(/github\.com/)
  })
})
