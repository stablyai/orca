import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelWebSessionCustomTitleIntent,
  reconcileWebSessionCustomTitleIntent,
  recordWebSessionCustomTitleIntent,
  resetWebSessionCustomTitleIntentsForTests
} from './web-session-custom-title-intent'

const OWNER = { environmentId: 'remote-1', pairingRevision: 1 }
const BASE = { owner: OWNER, worktreeId: 'repo::/worktree', hostTabId: 'host-tab' }

afterEach(() => resetWebSessionCustomTitleIntentsForTests())

describe('web session custom-title intent', () => {
  it('keeps an optimistic rename while the host still echoes the previous title', () => {
    recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: null,
      intendedTitle: 'Shared build',
      now: 1
    })

    expect(reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: null, now: 2 })).toBe(
      'Shared build'
    )
    expect(
      reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: 'Shared build', now: 3 })
    ).toBe('Shared build')
    expect(
      reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: 'Other client', now: 4 })
    ).toBe('Other client')
  })

  it('protects the newest rapid rename from the prior request acknowledgement', () => {
    recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: 'First',
      intendedTitle: 'Second',
      now: 1
    })
    recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: 'Second',
      intendedTitle: 'Third',
      now: 2
    })

    expect(reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: 'Second', now: 3 })).toBe(
      'Third'
    )
    expect(reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: 'Third', now: 4 })).toBe(
      'Third'
    )
  })

  it('accepts a concurrent third-party title and ignores cancellation from an older request', () => {
    const oldToken = recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: null,
      intendedTitle: 'First',
      now: 1
    })
    recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: 'First',
      intendedTitle: 'Second',
      now: 2
    })
    cancelWebSessionCustomTitleIntent(oldToken)

    expect(
      reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: 'Peer rename', now: 3 })
    ).toBe('Peer rename')
  })

  it('expires instead of masking a host value indefinitely', () => {
    recordWebSessionCustomTitleIntent({
      ...BASE,
      previousTitle: null,
      intendedTitle: 'Stale local',
      now: 1
    })

    expect(
      reconcileWebSessionCustomTitleIntent({ ...BASE, hostTitle: null, now: 30_002 })
    ).toBeNull()
  })
})
