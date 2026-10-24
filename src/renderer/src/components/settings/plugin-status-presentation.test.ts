import { describe, expect, it } from 'vitest'
import {
  isPluginEnabled,
  pluginNeedsReview,
  pluginStatusKind,
  pluginStatusLabel,
  sortByAttention
} from './plugin-status-presentation'
import type { PluginHostListEntry } from '../../../../preload/api-types'

function host(pluginKey: string, extra: Partial<PluginHostListEntry> = {}): PluginHostListEntry {
  return {
    pluginKey,
    consentFingerprint: null,
    name: pluginKey,
    version: '1.0.0',
    publisher: 'acme',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    ...extra
  }
}

const base = { status: 'running' as const, needsReconsent: false, blockedByKillList: undefined }

describe('plugin status presentation', () => {
  it('ranks the safety list, then review, over the worker state', () => {
    expect(pluginStatusKind({ ...base, blockedByKillList: { reason: 'unsafe' } })).toBe('blocked')
    expect(pluginStatusKind({ ...base, needsReconsent: true })).toBe('review')
    expect(pluginStatusKind({ ...base, status: 'pending' })).toBe('review')
    expect(pluginStatusKind({ ...base, status: 'errored' })).toBe('error')
    expect(pluginStatusKind({ ...base, status: 'idle' })).toBe('enabled')
    expect(pluginStatusLabel(pluginStatusKind(base))).toBe('Running')
  })

  it('counts a crashed plugin as switched on, and a pending one as needing review', () => {
    expect(isPluginEnabled({ status: 'errored' })).toBe(true)
    expect(isPluginEnabled({ status: 'disabled' })).toBe(false)
    expect(pluginNeedsReview({ status: 'pending', needsReconsent: false })).toBe(true)
  })

  it('puts plugins that need the user first, then updates, keeping order within each', () => {
    const rows = [
      { installed: host('a'), update: false },
      { installed: host('b'), update: true },
      { installed: host('c', { status: 'errored' }), update: false },
      { installed: host('d', { status: 'pending' }), update: false },
      { installed: host('e'), update: false }
    ]
    expect(
      sortByAttention(rows, (row) => row.update).map((row) => row.installed.pluginKey)
    ).toEqual(['c', 'd', 'b', 'a', 'e'])
  })
})
