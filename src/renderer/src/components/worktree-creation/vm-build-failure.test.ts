import { describe, expect, it } from 'vitest'
import { classifyVmBuildFailure, isAccountGate, type VmBuildFailure } from './vm-build-failure'
import { sandboxLimitFromBilling, vmBuildFailureCopy } from './vm-build-failure-copy'
import { orcaCloudRepoName } from './vm-build-repo-actions'
import type { Translate } from '@/i18n/use-translate'

// English defaults with {{slots}} filled, like i18next with no catalog.
const t: Translate = (_key, fallback, params) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_slot, name: string) => {
    const value: unknown = params?.[name]
    return value === undefined || value === null ? '' : String(value)
  })

function classify(
  errorCode: string | undefined,
  log = '',
  error = 'failed'
): VmBuildFailure | null {
  return classifyVmBuildFailure({
    entry: {
      phase: 'provisioning-vm',
      errorCode,
      provisioningLog: log,
      environmentCheck: undefined
    },
    error,
    cloud: true
  })
}

describe('classifyVmBuildFailure', () => {
  it('names each control-plane refusal from its streamed deny reason', () => {
    const kinds = Object.fromEntries(
      [
        ['cloudPlanRequired', 'included_hours_exhausted'],
        ['cloudPlanRequired', 'overage_cap_reached'],
        ['cloudPlanRequired', 'payment_grace_expired'],
        ['cloudConcurrencyLimit', 'member_concurrency_limit'],
        ['cloudConcurrencyLimit', 'concurrency_limit']
      ].map(([code, reason]) => [reason, classify(code, `Orca Cloud: ${reason}`)?.kind])
    )
    expect(kinds).toEqual({
      included_hours_exhausted: 'hoursUsed',
      overage_cap_reached: 'spendCap',
      payment_grace_expired: 'payment',
      member_concurrency_limit: 'memberConcurrency',
      concurrency_limit: 'concurrency'
    })
    expect(classify('cloudPlanRequired')?.kind).toBe('plan')
  })

  it('treats GitHub refusals as gates that started nothing', () => {
    for (const code of ['cloudGithubNotConnected', 'cloudNoGithubRemote']) {
      expect(isAccountGate(classify(code))).toBe(true)
    }
  })
})

describe('vmBuildFailureCopy', () => {
  const kinds: VmBuildFailure[] = [
    { kind: 'plan' },
    { kind: 'hoursUsed' },
    { kind: 'spendCap' },
    { kind: 'payment' },
    { kind: 'concurrency' },
    { kind: 'memberConcurrency' },
    { kind: 'githubNotConnected' },
    { kind: 'noGithubRemote' },
    { kind: 'signIn' },
    { kind: 'unavailable' },
    { kind: 'network' },
    { kind: 'snapshotMissing' },
    { kind: 'provision', error: 'Recipe exited with code 1.' },
    { kind: 'create', error: 'checkout failed' }
  ]

  it('never shows codes, ids or banned glossary terms on an Orca Cloud card', () => {
    for (const canManageBilling of [true, false]) {
      for (const failure of kinds) {
        const { title, body } = vmBuildFailureCopy(
          failure,
          { cloud: true, canManageBilling, repoName: 'acme/web' },
          t
        )
        const text = `${title} ${body ?? ''}`
        expect(text).not.toMatch(
          /[a-z]+_[a-z]+|\bVM\b|included hours|hours exhausted|overage limit/
        )
        // Nothing exists yet at create time, so there are no files to reassure about.
        expect(text).not.toContain('Your files are safe')
      }
    }
  })

  it('uses the glossary titles and role-aware next steps for billing refusals', () => {
    const copy = (kind: VmBuildFailure, canManageBilling: boolean) =>
      vmBuildFailureCopy(kind, { cloud: true, canManageBilling, repoName: 'acme/web' }, t)
    expect(copy({ kind: 'hoursUsed' }, true).title).toBe('Out of sandbox hours')
    expect(copy({ kind: 'spendCap' }, true).title).toBe('Spend cap reached')
    expect(copy({ kind: 'payment' }, true).title).toBe('Payment failed')
    expect(copy({ kind: 'hoursUsed' }, false).body).toContain('Ask an owner or admin to add hours.')
    expect(copy({ kind: 'payment' }, false).body).toContain(
      'Ask an owner or admin to update the payment method.'
    )
  })

  it('states the running-sandbox cap on the limit cards once the plan is known', () => {
    const copy = (kind: VmBuildFailure, sandboxLimit: { perSeat: number; team: number } | null) =>
      vmBuildFailureCopy(
        kind,
        { cloud: true, canManageBilling: true, repoName: 'acme/web', sandboxLimit },
        t
      ).body
    expect(copy({ kind: 'concurrency' }, { perSeat: 3, team: 12 })).toContain(
      'Your team can run 12 sandboxes at once (3 per seat). Put one to sleep or delete it'
    )
    expect(copy({ kind: 'memberConcurrency' }, { perSeat: 3, team: 12 })).toContain(
      'You can run 3 sandboxes at once. Put one to sleep or delete it'
    )
    expect(copy({ kind: 'concurrency' }, null)).toMatch(/^Put one to sleep or delete it/)
  })

  it('derives the caps the way billing enforces them', () => {
    const status = (seats: number, perSeat: number | null) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sandboxLimitFromBilling reads only seats and offers.
      ({
        status: 'ok',
        entitlement: {
          seats,
          offers: perSeat === null ? null : { team: { concurrentSandboxesPerSeat: perSeat } }
        }
      }) as unknown as Parameters<typeof sandboxLimitFromBilling>[0]
    expect(sandboxLimitFromBilling(status(4, 3))).toEqual({ perSeat: 3, team: 12 })
    // Billing counts at least one seat.
    expect(sandboxLimitFromBilling(status(0, 3))).toEqual({ perSeat: 3, team: 3 })
    expect(sandboxLimitFromBilling(status(4, null))).toBeNull()
    expect(sandboxLimitFromBilling(null)).toBeNull()
  })

  it('names the repository GitHub needs to reach', () => {
    const { title } = vmBuildFailureCopy(
      { kind: 'githubNotConnected' },
      { cloud: true, canManageBilling: true, repoName: 'acme/web' },
      t
    )
    expect(title).toBe('GitHub isn’t connected for acme/web')
  })
})

describe('orcaCloudRepoName', () => {
  it('prefers the GitHub owner/name, falling back to the name in Orca', () => {
    expect(
      orcaCloudRepoName({
        displayName: 'web',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/acme/web',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:acme/web.git'
        }
      })
    ).toBe('acme/web')
    expect(orcaCloudRepoName({ displayName: 'web', gitRemoteIdentity: null })).toBe('web')
  })
})
