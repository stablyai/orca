import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GiteaAuthDiagnostic } from '../../../../shared/gitea-types'
import {
  fetchGiteaAuthDiagnostic,
  fetchGiteaRateLimit,
  summarizeGiteaAuthDiagnostic
} from './gitea-rate-limit-display'

const LOCAL = { kind: 'local' } as const

function diag(overrides: Partial<GiteaAuthDiagnostic>): GiteaAuthDiagnostic {
  return {
    gtAvailable: true,
    gtVersion: null,
    authenticated: true,
    hosts: [],
    activeHost: null,
    logins: [],
    envTokenInProcess: null,
    error: null,
    ...overrides
  }
}

describe('gitea rate-limit display', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls the local gitea preload API for rate limit and auth diagnostics', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ ok: false, error: 'x' })
    const diagnoseAuth = vi.fn().mockResolvedValue(diag({}))
    vi.stubGlobal('window', { api: { gitea: { rateLimit, diagnoseAuth } } })

    await fetchGiteaRateLimit(LOCAL, true)
    await fetchGiteaRateLimit(LOCAL, false)
    await fetchGiteaAuthDiagnostic(LOCAL)

    expect(rateLimit).toHaveBeenNthCalledWith(1, { force: true })
    expect(rateLimit).toHaveBeenNthCalledWith(2, undefined)
    expect(diagnoseAuth).toHaveBeenCalledOnce()
  })

  it('summarizes gt availability and login state', () => {
    expect(summarizeGiteaAuthDiagnostic(diag({ gtAvailable: false }))).toContain('not installed')
    expect(
      summarizeGiteaAuthDiagnostic(
        diag({ gtAvailable: false, envTokenInProcess: 'ORCA_GITEA_TOKEN' })
      )
    ).toContain('ORCA_GITEA_TOKEN')
    expect(summarizeGiteaAuthDiagnostic(diag({ authenticated: false }))).toContain('gt auth login')
    expect(summarizeGiteaAuthDiagnostic(diag({ activeHost: 'gitea.example.com' }))).toContain(
      'gitea.example.com'
    )
  })
})
