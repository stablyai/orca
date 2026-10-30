import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../../../../../shared/update-status-types'
import { buildUpdateCardErrorModel } from './update-card-error-model'

function build(status: UpdateStatus, isLocalBuild = false) {
  return buildUpdateCardErrorModel({
    status,
    isLocalBuild,
    cachedVersion: '1.4.200',
    installError: null,
    compatibilityRelaunching: false,
    compatibilitySetupError: null,
    onChooseLocalBuild: vi.fn(),
    onEnableHttp1Compatibility: vi.fn(),
    onRetryDownload: vi.fn(),
    onRecheck: vi.fn(),
    onInstallRetry: vi.fn()
  })
}

describe('update card error model precedence', () => {
  it('keeps a local build failure out of platform download recovery', () => {
    const model = build(
      {
        state: 'error',
        source: 'local',
        message: 'New version is not signed by the application owner'
      },
      true
    )
    expect(model?.title).toBe('Local Build Error')
    expect(model?.primaryAction?.label).toBe('Choose Another Build')
    expect(model?.releaseUrl).toBeUndefined()
  })

  it('routes publisher mismatch ahead of the generic retry model', () => {
    const model = build({
      state: 'error',
      message: 'New version 1.4.200 is not signed by the application owner: publisherNames: Orca'
    })
    expect(model?.variant).toBe('security')
    expect(model?.primaryAction).toBeUndefined()
    expect(model?.manualLabel).toBe('Check official releases')
  })

  it('preserves the pending HTTP/1 compatibility recovery action', () => {
    const onEnableHttp1Compatibility = vi.fn()
    const model = buildUpdateCardErrorModel({
      status: { state: 'error', message: 'net::ERR_HTTP2_PROTOCOL_ERROR' },
      isLocalBuild: false,
      cachedVersion: '1.4.200',
      installError: null,
      compatibilityRelaunching: true,
      compatibilitySetupError: null,
      onChooseLocalBuild: vi.fn(),
      onEnableHttp1Compatibility,
      onRetryDownload: vi.fn(),
      onRecheck: vi.fn(),
      onInstallRetry: vi.fn()
    })
    expect(model?.variant).toBe('http1Compatibility')
    expect(model?.primaryAction).toMatchObject({
      label: 'Enable & Restart',
      pendingLabel: 'Restarting...',
      isPending: true,
      onClick: onEnableHttp1Compatibility
    })
  })
})
