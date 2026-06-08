import { describe, expect, it } from 'vitest'
import { tabHasFreshInputRequest } from './tab-input-request'

const NOW = 10_000_000
const LEAF = '00000000-0000-1000-8000-000000000000'
const key = (tabId: string): string => `${tabId}:${LEAF}`

describe('tabHasFreshInputRequest', () => {
  it('is true when a pane in the tab is freshly blocked (needs input)', () => {
    const map = { [key('tab-1')]: { state: 'blocked' as const, updatedAt: NOW } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(true)
  })

  it('is true for a freshly waiting pane', () => {
    const map = { [key('tab-1')]: { state: 'waiting' as const, updatedAt: NOW } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(true)
  })

  // Why: a finished agent is the green-dot case — it must not light the bell.
  it('is false for a completed (done) agent', () => {
    const map = { [key('tab-1')]: { state: 'done' as const, updatedAt: NOW } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(false)
  })

  it('is false for a working agent', () => {
    const map = { [key('tab-1')]: { state: 'working' as const, updatedAt: NOW } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(false)
  })

  it('ignores blocked panes that belong to a different tab', () => {
    const map = { [key('tab-2')]: { state: 'blocked' as const, updatedAt: NOW } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(false)
  })

  it('ignores a blocked entry that has gone stale', () => {
    const map = { [key('tab-1')]: { state: 'blocked' as const, updatedAt: 0 } }
    expect(tabHasFreshInputRequest(map, 'tab-1', NOW)).toBe(false)
  })
})
