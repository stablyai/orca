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

/**
 * The model is nullable, and these assertions read every field on it. A null
 * here should fail as "no model was built" rather than as a confusing mismatch
 * on a property that was never going to exist.
 */
function buildErrorModel(status: UpdateStatus): NonNullable<ReturnType<typeof build>> {
  const model = build(status)
  if (!model) {
    throw new Error(`buildUpdateCardErrorModel returned null for state=${status.state}`)
  }
  return model
}

describe('install errors the user has to act on', () => {
  // Why this matters beyond formatting: `detail` is rendered only after the user
  // opens "Show details", in a muted monospace box captioned DETAILS — the
  // surface built for stack dumps. An error whose message IS the instruction
  // (which copies of the app to quit before the macOS install can proceed) has
  // to reach the summary line, and only a non-retryable error does.
  const blockedInstall = {
    state: 'error',
    message: 'Another copy of Orca is running (PID 270).',
    retryable: false,
    version: '1.4.201'
  } as const

  it('promotes the message to the summary when the error is not retryable', () => {
    const model = buildErrorModel(blockedInstall)

    expect(model.summary).toBe(blockedInstall.message)
  })

  it('buries the same message behind Show details when it is retryable', () => {
    const model = buildErrorModel({ ...blockedInstall, retryable: true })

    expect(model.summary).toBe('Could not complete the update.')
    expect(model.detail).toBe(blockedInstall.message)
  })

  it('still offers a manual download when there is no retry action', () => {
    const model = buildErrorModel(blockedInstall)

    expect(model.primaryAction).toBeUndefined()
    expect(model.releaseUrl).toBeTruthy()
  })
})
