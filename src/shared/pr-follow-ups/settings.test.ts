import { describe, expect, it } from 'vitest'
import { patchPrFollowUps, resolvePrFollowUps } from './settings'

describe('PR follow-up settings', () => {
  it('inherits each field and treats newer action words as off without rewriting them', () => {
    const global = { enabled: true, events: { ciFailed: 'new-agent' }, maxAutoRunsPerPr: 2 }
    expect(resolvePrFollowUps(global, { events: { ciFailed: 'off' } })).toEqual({
      enabled: true,
      ciFailed: 'off',
      maxAutoRunsPerPr: 2
    })
    expect(resolvePrFollowUps(undefined)).toEqual({
      enabled: false,
      ciFailed: 'new-agent',
      maxAutoRunsPerPr: 3
    })
    const raw = {
      enabled: true,
      events: { ciFailed: 'future-action', reviewComment: 'send-owner' }
    }
    expect(resolvePrFollowUps(raw).ciFailed).toBe('off')
    expect(patchPrFollowUps(raw, { path: 'enabled', value: false })).toEqual({
      enabled: false,
      events: { ciFailed: 'future-action', reviewComment: 'send-owner' }
    })
    const patched = patchPrFollowUps(raw, { path: 'events.ciFailed', value: 'new-agent' })
    expect(patched).toEqual({
      enabled: true,
      events: { ciFailed: 'new-agent', reviewComment: 'send-owner' }
    })
    expect(raw.events.ciFailed).toBe('future-action')
    expect(patchPrFollowUps(patched, { path: 'events.ciFailed', value: null }).events).toEqual({
      reviewComment: 'send-owner'
    })
  })
})
