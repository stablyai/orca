import { afterEach, describe, expect, it } from 'vitest'
import type { SecretRequestedEvent } from '../../../../shared/secret-request-contract'
import {
  applySecretRequested,
  applySecretRequestSettled,
  dismissSecretRequest,
  readSecretRequests,
  resetSecretRequestStoreForTests,
  setSecretRequestExpiry,
  setSecretRequestLocal
} from './secret-request-store'
import { isSecretRequestedEvent, isSecretRequestSettledEvent } from './secret-request-event-guards'
import {
  routeSecretRequests,
  secretRequestAgentName,
  type SecretRequestPaneSlot
} from './secret-request-routing'

function requested(patch: Partial<SecretRequestedEvent> = {}): SecretRequestedEvent {
  return {
    type: 'secrets.requested',
    requestId: 'sr_aaaaaaaa',
    name: 'NPM_TOKEN',
    reason: 'Needed for npm.acme.dev',
    scope: 'personal',
    agent: 'claude',
    worktreeId: null,
    terminalHandle: 'h1',
    requestedAt: 1_000,
    expiresAt: 1_000 + 15 * 60_000,
    ...patch
  }
}

describe('secret request store', () => {
  afterEach(() => resetSecretRequestStoreForTests())

  it('keeps what this window did when orcad replays a request on attach', () => {
    applySecretRequested('env', requested())
    setSecretRequestLocal('env', 'sr_aaaaaaaa', 'saving')
    applySecretRequested('env', requested())
    expect(readSecretRequests()).toHaveLength(1)
    expect(readSecretRequests()[0].local).toBe('saving')
  })

  it('drops a request another client settled, but keeps one this window finished', () => {
    applySecretRequested('env', requested())
    applySecretRequested('env', requested({ requestId: 'sr_bbbbbbbb', name: 'B' }))
    setSecretRequestLocal('env', 'sr_bbbbbbbb', 'saved')
    applySecretRequestSettled('env', {
      type: 'secrets.requestSettled',
      requestId: 'sr_aaaaaaaa',
      status: 'declined'
    })
    applySecretRequestSettled('env', {
      type: 'secrets.requestSettled',
      requestId: 'sr_bbbbbbbb',
      status: 'provided'
    })
    expect(readSecretRequests().map((entry) => entry.event.name)).toEqual(['B'])
    dismissSecretRequest('env', 'sr_bbbbbbbb')
    expect(readSecretRequests()).toEqual([])
  })

  it('shows an expiry reported by orcad as the expired state', () => {
    applySecretRequested('env', requested())
    applySecretRequestSettled('env', {
      type: 'secrets.requestSettled',
      requestId: 'sr_aaaaaaaa',
      status: 'expired'
    })
    expect(readSecretRequests()[0].local).toBe('expired')
  })

  it('moves the expiry when a touch extends it', () => {
    applySecretRequested('env', requested())
    setSecretRequestExpiry('env', 'sr_aaaaaaaa', 99_000_000)
    expect(readSecretRequests()[0].event.expiresAt).toBe(99_000_000)
  })

  it('keeps requests from different hosts apart', () => {
    applySecretRequested('a', requested())
    applySecretRequested('b', requested())
    expect(readSecretRequests()).toHaveLength(2)
  })
})

describe('event guards', () => {
  it('accepts the contract shape and rejects markup or oversized fields', () => {
    expect(isSecretRequestedEvent(requested())).toBe(true)
    expect(isSecretRequestedEvent(requested({ name: '<b>x</b>' }))).toBe(false)
    expect(isSecretRequestedEvent(requested({ reason: 'x'.repeat(201) }))).toBe(false)
    expect(isSecretRequestedEvent({ ...requested(), requestId: 'nope' })).toBe(false)
    expect(
      isSecretRequestSettledEvent({
        type: 'secrets.requestSettled',
        requestId: 'sr_aaaaaaaa',
        status: 'provided'
      })
    ).toBe(true)
  })
})

describe('routeSecretRequests', () => {
  const slot = (patch: Partial<SecretRequestPaneSlot>): SecretRequestPaneSlot => ({
    paneKey: 'tab:1',
    environmentId: 'env',
    handle: null,
    primary: false,
    ...patch
  })

  it('pins a request to the pane running the asking terminal', () => {
    applySecretRequested('env', requested({ terminalHandle: 'h2' }))
    const routed = routeSecretRequests(readSecretRequests(), [
      slot({ paneKey: 'tab:1', handle: 'h1', primary: true }),
      slot({ paneKey: 'tab:2', handle: 'h2' })
    ])
    expect([...routed.keys()]).toEqual(['tab:2'])
    resetSecretRequestStoreForTests()
  })

  it('falls back to the active pane on the same host, and stacks the rest there', () => {
    applySecretRequested('env', requested({ terminalHandle: undefined }))
    applySecretRequested('env', requested({ requestId: 'sr_cccccccc', terminalHandle: 'gone' }))
    applySecretRequested('other', requested({ requestId: 'sr_dddddddd' }))
    const routed = routeSecretRequests(readSecretRequests(), [
      slot({ paneKey: 'tab:1', handle: 'h1' }),
      slot({ paneKey: 'tab:9', handle: 'h9', primary: true })
    ])
    expect(routed.get('tab:9')?.map((entry) => entry.event.requestId)).toEqual([
      'sr_aaaaaaaa',
      'sr_cccccccc'
    ])
    // Nothing on the other host is mounted here, so its request waits.
    expect(routed.size).toBe(1)
    resetSecretRequestStoreForTests()
  })
})

describe('secretRequestAgentName', () => {
  it('names known agents and cleans unknown ids', () => {
    expect(secretRequestAgentName('claude')).toBe('Claude')
    expect(secretRequestAgentName('my<agent>')).toBe('Myagent')
    expect(secretRequestAgentName(null)).toBeNull()
  })
})
