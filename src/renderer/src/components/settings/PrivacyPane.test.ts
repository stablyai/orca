// PrivacyPane tests. The contract pinned here:
//
//   1. Toggle wiring — the rendered toggle reflects `settings.telemetry.optedIn`.
//   2. Blocked-state predicates:
//      - `isEnvBlocked` — the env-only detector, used by `computeBlockedReason`.
//      - `computeBlockedReason` — the full gate, including first-launch-
//        pending reasons. Env-var wins over first-launch so the user sees
//        the hard constraint named first.
//   3. Env-var naming — `envVarNameForReason` names the specific variable.
//
// Keeping these as pure helpers lets tests cover them without a DOM
// harness (this repo's vitest runs in node-env, so `useEffect` does not
// fire under `renderToStaticMarkup`).

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { TelemetryConsentState } from '../../../../shared/telemetry-consent-types'

const { getConsentStateMock, setOptInMock } = vi.hoisted(() => ({
  getConsentStateMock: vi.fn<() => Promise<TelemetryConsentState>>(),
  setOptInMock: vi.fn<(optedIn: boolean) => Promise<void>>()
}))
vi.mock('../../lib/telemetry', () => ({
  getConsentState: getConsentStateMock,
  setOptIn: setOptInMock
}))

import { PrivacyPane, computeBlockedReason, envVarNameForReason, isEnvBlocked } from './PrivacyPane'

function buildSettings(
  telemetry: Partial<NonNullable<GlobalSettings['telemetry']>> = {}
): GlobalSettings {
  return {
    telemetry: {
      installId: 'test-install-id',
      existedBeforeTelemetryRelease: false,
      optedIn: true,
      ...telemetry
    }
  } as unknown as GlobalSettings
}

describe('PrivacyPane — toggle markup reflects stored preference', () => {
  beforeEach(() => {
    getConsentStateMock.mockReset()
    getConsentStateMock.mockResolvedValue({ effective: 'enabled' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the toggle in its checked state when optedIn is true', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({ optedIn: true })
      })
    )
    expect(markup).toContain('aria-checked="true"')
  })

  it('renders the toggle unchecked when optedIn is false', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({ optedIn: false })
      })
    )
    expect(markup).toContain('aria-checked="false"')
  })

  it('renders the toggle unchecked when optedIn is null (existing user pre-banner)', () => {
    // `optedIn === null` is the existing-user cohort awaiting the banner.
    // No events transmit in that state; the Settings toggle should visibly
    // read "off" so flipping it on routes through the 'settings' `via`
    // path (not 'first_launch_banner', which is reserved for the banner).
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({
          existedBeforeTelemetryRelease: true,
          optedIn: null
        })
      })
    )
    expect(markup).toContain('aria-checked="false"')
  })
})

describe('PrivacyPane — isEnvBlocked', () => {
  it('returns true for DO_NOT_TRACK', () => {
    expect(isEnvBlocked({ effective: 'disabled', reason: 'do_not_track' })).toBe(true)
  })

  it('returns true for ORCA_TELEMETRY_DISABLED', () => {
    expect(isEnvBlocked({ effective: 'disabled', reason: 'orca_disabled' })).toBe(true)
  })

  it('returns true for CI', () => {
    expect(isEnvBlocked({ effective: 'disabled', reason: 'ci' })).toBe(true)
  })

  it('returns false for user_opt_out (not env-blocked — the toggle remains actionable)', () => {
    // `user_opt_out` is a stored-preference state, not an env override.
    // The toggle MUST stay enabled so the user can flip back on; getting
    // this wrong would trap a user who opted out once inside an inert UI.
    expect(isEnvBlocked({ effective: 'disabled', reason: 'user_opt_out' })).toBe(false)
  })

  it('returns false for pending_banner', () => {
    expect(isEnvBlocked({ effective: 'pending_banner' })).toBe(false)
  })

  it('returns false for enabled', () => {
    expect(isEnvBlocked({ effective: 'enabled' })).toBe(false)
  })

  it('returns false for null (consent not yet fetched)', () => {
    expect(isEnvBlocked(null)).toBe(false)
  })
})

describe('PrivacyPane — envVarNameForReason', () => {
  it('maps do_not_track to DO_NOT_TRACK', () => {
    expect(envVarNameForReason('do_not_track')).toBe('DO_NOT_TRACK')
  })

  it('maps orca_disabled to ORCA_TELEMETRY_DISABLED', () => {
    expect(envVarNameForReason('orca_disabled')).toBe('ORCA_TELEMETRY_DISABLED')
  })

  it('maps ci to CI', () => {
    expect(envVarNameForReason('ci')).toBe('CI')
  })
})

describe('PrivacyPane — computeBlockedReason', () => {
  it('returns null when consent is enabled', () => {
    expect(computeBlockedReason({ effective: 'enabled' })).toBeNull()
  })

  it('returns null for a user_opt_out state (the toggle must remain actionable)', () => {
    // A user who opted out must be able to flip back on from Settings.
    expect(computeBlockedReason({ effective: 'disabled', reason: 'user_opt_out' })).toBeNull()
  })

  it('returns null for pending_banner (banner-pending does NOT gate the toggle)', () => {
    // Flipping the Settings toggle is a valid way to resolve the notice:
    // it moves `optedIn` off `null`, which un-mounts the banner on its own.
    expect(computeBlockedReason({ effective: 'pending_banner' })).toBeNull()
  })

  it('names DO_NOT_TRACK as the env reason when set', () => {
    const result = computeBlockedReason({ effective: 'disabled', reason: 'do_not_track' })
    expect(result).toEqual({ kind: 'env', reason: 'do_not_track' })
  })

  it('names ORCA_TELEMETRY_DISABLED as the env reason when set', () => {
    const result = computeBlockedReason({ effective: 'disabled', reason: 'orca_disabled' })
    expect(result).toEqual({ kind: 'env', reason: 'orca_disabled' })
  })

  it('names CI as the env reason when set', () => {
    const result = computeBlockedReason({ effective: 'disabled', reason: 'ci' })
    expect(result).toEqual({ kind: 'env', reason: 'ci' })
  })
})

describe('PrivacyPane — markup respects blocked state', () => {
  // The useEffect that fetches consent does not run in renderToStaticMarkup
  // (no DOM, no state flushes), so the rendered toggle always reads the
  // `consent === null` branch of the effect. Env-var blocked-state markup
  // is covered by the computeBlockedReason unit tests above; here we just
  // confirm the toggle is live for the cohorts that should be able to flip
  // it.
  beforeEach(() => {
    getConsentStateMock.mockReset()
    getConsentStateMock.mockResolvedValue({ effective: 'enabled' })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves the toggle enabled for a new user', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({
          existedBeforeTelemetryRelease: false,
          optedIn: true
        })
      })
    )
    // Negative assertion: the disabled attribute should not appear on the
    // switch. renderToStaticMarkup elides `disabled={false}` entirely.
    expect(markup).not.toMatch(/role="switch"[^>]*disabled/)
  })

  it('leaves the toggle enabled for an existing user awaiting the banner (flip dismisses the banner)', () => {
    // Flipping the toggle moves `optedIn` off `null`, which un-mounts the
    // notice via TelemetryFirstLaunchSurface's cohort check. The Settings
    // toggle is one of the valid ways to resolve the notice.
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({
          existedBeforeTelemetryRelease: true,
          optedIn: null
        })
      })
    )
    expect(markup).not.toMatch(/role="switch"[^>]*disabled/)
  })

  it('leaves the toggle enabled once the existing-user banner is resolved', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({
          existedBeforeTelemetryRelease: true,
          optedIn: true
        })
      })
    )
    expect(markup).not.toMatch(/role="switch"[^>]*disabled/)
  })
})
