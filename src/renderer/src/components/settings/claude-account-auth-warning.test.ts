import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../../../shared/rate-limit-types'
import {
  claudeRateLimitTargetMatchesAccountRuntime,
  getClaudeSystemDefaultSignInWarning
} from './claude-account-auth-warning'

function claudeLimits(
  status: ProviderRateLimits['status'],
  failureKind: UsageRateLimitFailureKind = 'signed-out'
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: 'Claude sign-in expired',
    status,
    usageMetadata: { failureKind }
  }
}

const hostTarget = { runtime: 'host', wslDistro: null } as const

describe('claude system default sign-in warning', () => {
  it('warns when the host snapshot reports signed-out', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits('error'),
        target: hostTarget,
        runtime: { runtime: 'host' },
        systemActive: true
      })
    ).toBe(true)
  })

  it('stays quiet when a managed account is selected', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits('error'),
        target: hostTarget,
        runtime: { runtime: 'host' },
        systemActive: false
      })
    ).toBe(false)
  })

  it('stays quiet for other failure kinds and non-error snapshots', () => {
    const base = {
      target: hostTarget,
      runtime: { runtime: 'host' },
      systemActive: true
    } as const
    expect(
      getClaudeSystemDefaultSignInWarning({
        ...base,
        limits: claudeLimits('error', 'missing-credentials')
      })
    ).toBe(false)
    expect(
      getClaudeSystemDefaultSignInWarning({
        ...base,
        limits: claudeLimits('unavailable', 'signed-out')
      })
    ).toBe(false)
    expect(getClaudeSystemDefaultSignInWarning({ ...base, limits: null })).toBe(false)
  })

  it('stays quiet when the snapshot target does not match the viewed runtime', () => {
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits('error'),
        target: hostTarget,
        runtime: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        systemActive: true
      })
    ).toBe(false)
    expect(
      getClaudeSystemDefaultSignInWarning({
        limits: claudeLimits('error'),
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        runtime: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        systemActive: true
      })
    ).toBe(true)
  })

  it('matches targets the same way the Codex warning does', () => {
    expect(claudeRateLimitTargetMatchesAccountRuntime(hostTarget, { runtime: 'host' })).toBe(true)
    expect(
      claudeRateLimitTargetMatchesAccountRuntime(hostTarget, {
        runtime: 'wsl',
        wslDistro: 'Ubuntu'
      })
    ).toBe(false)
  })
})
