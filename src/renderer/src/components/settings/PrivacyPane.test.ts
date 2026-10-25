// Use pure predicates for consent gates because static SSR never runs the consent-loading effect.

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
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
    // Banner-pending users transmit nothing; Settings opt-in uses its own attribution and resolves the notice.
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
    // User opt-out is reversible preference, so it must not disable the toggle like an environment constraint.
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
    expect(computeBlockedReason({ effective: 'disabled', reason: 'user_opt_out' })).toBeNull()
  })

  it('returns null for pending_banner (banner-pending does NOT gate the toggle)', () => {
    // Settings opt-in clears optedIn=null and dismisses the first-launch notice.
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
  const switchTag = (markup: string): string =>
    markup.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? ''

  // Static SSR keeps consent null; predicate tests cover blocked reasons, while these cases verify actionable cohorts.
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
    expect(switchTag(markup)).not.toContain(' disabled=""')
  })

  it('leaves the toggle enabled for an existing user awaiting the banner (flip dismisses the banner)', () => {
    const markup = renderToStaticMarkup(
      React.createElement(PrivacyPane, {
        settings: buildSettings({
          existedBeforeTelemetryRelease: true,
          optedIn: null
        })
      })
    )
    expect(switchTag(markup)).not.toContain(' disabled=""')
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
    expect(switchTag(markup)).not.toContain(' disabled=""')
  })
})
