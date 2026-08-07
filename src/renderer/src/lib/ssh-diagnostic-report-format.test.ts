import { describe, expect, it } from 'vitest'
import { formatSshDiagnosticReport, type SshDiagnosticReport } from './ssh-diagnostic-report'

type TimelineEntry = SshDiagnosticReport['timeline'][number]

const CONNECTED_ENTRY: TimelineEntry = {
  atMs: 1_000,
  status: 'connected',
  attempt: 0,
  repeats: 1,
  runMs: null,
  error: null,
  errorCategory: null,
  generation: 12,
  origin: 'push'
}

const RECONNECTING_ENTRY: TimelineEntry = {
  atMs: 104_000,
  status: 'reconnecting',
  attempt: 3,
  repeats: 4,
  runMs: 9_000,
  error: 'Relay channel lost. Reconnecting...',
  errorCategory: 'relay',
  generation: 12,
  origin: 'push'
}

const HEALTHY: SshDiagnosticReport = {
  captureId: '4f2a1b9c',
  capturedAt: '2026-08-04T10:00:00.000Z',
  appVersion: '1.4.170',
  clientPlatform: 'darwin',
  live: {
    status: 'reconnecting',
    liveStatePresent: true,
    error: 'Relay channel lost. Reconnecting...',
    errorCategory: 'relay',
    reconnectAttempt: 3,
    connectionGeneration: 12,
    remotePlatform: 'linux',
    supportsFolderDownload: true,
    targetRemoved: false,
    runtimeOwned: false
  },
  timeline: [CONNECTED_ENTRY, RECONNECTING_ENTRY],
  sectionErrors: {}
}

const EVERY_SECTION_FAILED: SshDiagnosticReport = {
  captureId: 'unknown',
  capturedAt: '',
  appVersion: null,
  clientPlatform: 'unknown',
  live: {
    status: null,
    liveStatePresent: false,
    error: null,
    errorCategory: null,
    reconnectAttempt: null,
    connectionGeneration: null,
    remotePlatform: null,
    supportsFolderDownload: null,
    targetRemoved: true,
    runtimeOwned: true
  },
  timeline: [],
  sectionErrors: {
    live: 'Error: store exploded',
    timeline: 'Error: ring exploded',
    captureId: 'Error: no randomness',
    capturedAt: 'Error: no clock',
    clientPlatform: 'Error: no navigator'
  }
}

function headerOf(report: SshDiagnosticReport): string[] {
  return formatSshDiagnosticReport(report).split('\n\n```json\n')[0]?.split('\n') ?? []
}

function parseFence(text: string): unknown {
  const body = text.split('\n\n```json\n')[1]?.replace(/\n```\n$/, '')
  return JSON.parse(body ?? '')
}

describe('formatSshDiagnosticReport', () => {
  it('derives every header line from the JSON', () => {
    expect(headerOf(HEALTHY)).toEqual([
      'SSH diagnostics 4f2a1b9c',
      'Captured: 2026-08-04T10:00:00.000Z',
      'App: 1.4.170 · Client platform: darwin (this device, not the SSH host)',
      'Status: reconnecting (attempt 3)',
      'Connection generation: 12',
      'Remote platform: linux · Folder download: true',
      'Target removed: false · Runtime-owned: false',
      'Timeline: 2 entries, spanning 103s',
      'Last error [relay]: Relay channel lost. Reconnecting...',
      'Section errors: none'
    ])
  })

  it('derives the header for the every-section-failed report', () => {
    expect(headerOf(EVERY_SECTION_FAILED)).toEqual([
      'SSH diagnostics unknown',
      'Captured: unknown',
      'App: unknown · Client platform: unknown (this device, not the SSH host)',
      'Status: unknown (no live state — defaulted)',
      'Connection generation: unknown',
      'Remote platform: unknown · Folder download: unknown',
      'Target removed: true · Runtime-owned: true',
      'Timeline: 0 entries',
      'Last error: none',
      'Section errors: live, timeline, captureId, capturedAt, clientPlatform'
    ])
  })

  // The removed-target overlay is a state users capture from, and by then
  // `clearRemovedSshTargetState` has deleted the store entry — so a live-only
  // header printed "Last error: none" directly above the real failure in the JSON.
  it('falls back to the newest timeline error when live state is gone', () => {
    const ghost: SshDiagnosticReport = {
      ...HEALTHY,
      live: { ...HEALTHY.live, error: null, errorCategory: null, liveStatePresent: false },
      timeline: [
        { ...RECONNECTING_ENTRY, error: 'earlier failure', errorCategory: 'reset' },
        { ...RECONNECTING_ENTRY, error: 'Permission denied (publickey).', errorCategory: 'auth' }
      ]
    }

    expect(headerOf(ghost)[8]).toBe(
      'Last error [auth] (from timeline): Permission denied (publickey).'
    )
  })

  it('still reports none when neither live nor the timeline carries an error', () => {
    const quiet: SshDiagnosticReport = {
      ...HEALTHY,
      live: { ...HEALTHY.live, error: null, errorCategory: null },
      timeline: [CONNECTED_ENTRY]
    }

    expect(headerOf(quiet)[8]).toBe('Last error: none')
  })

  it('agrees with the overlay when the store held no live state', () => {
    const defaulted: SshDiagnosticReport = {
      ...HEALTHY,
      live: { ...HEALTHY.live, status: 'disconnected', liveStatePresent: false }
    }

    expect(headerOf(defaulted)[3]).toBe(
      'Status: disconnected (attempt 3) (no live state — defaulted)'
    )
  })

  it('counts a folded first entry from its run start, not its last arrival', () => {
    const folded: SshDiagnosticReport = {
      ...HEALTHY,
      timeline: [
        { ...CONNECTED_ENTRY, atMs: 6_000, repeats: 3, runMs: 5_000 },
        { ...RECONNECTING_ENTRY, atMs: 106_000 }
      ]
    }

    expect(headerOf(folded)[7]).toBe('Timeline: 2 entries, spanning 105s')
  })

  it('reports a sub-second span in milliseconds rather than rounding it to 0s', () => {
    const brief: SshDiagnosticReport = {
      ...HEALTHY,
      timeline: [CONNECTED_ENTRY, { ...RECONNECTING_ENTRY, atMs: 1_400, runMs: null }]
    }

    expect(headerOf(brief)[7]).toBe('Timeline: 2 entries, spanning 400ms')
  })

  it('omits the span when a single entry cannot bound one', () => {
    const single: SshDiagnosticReport = { ...HEALTHY, timeline: [CONNECTED_ENTRY] }

    expect(headerOf(single)[7]).toBe('Timeline: 1 entry')
  })

  it('keeps a multi-line error from breaking the header apart', () => {
    const multiline: SshDiagnosticReport = {
      ...HEALTHY,
      live: {
        ...HEALTHY.live,
        error: 'kex_exchange_identification: Connection closed\r\nbanner exchange failed',
        errorCategory: 'reset'
      }
    }

    const header = headerOf(multiline)

    expect(header[8]).toBe('Last error [reset]: kex_exchange_identification: Connection closed')
    expect(header[9]).toBe('Section errors: none')
    // The JSON block still carries the whole value.
    expect(formatSshDiagnosticReport(multiline)).toContain('banner exchange failed')
  })

  it('tracks the JSON when a field changes', () => {
    const mutated: SshDiagnosticReport = {
      ...HEALTHY,
      captureId: 'aaaa1111',
      live: { ...HEALTHY.live, status: 'auth-failed', reconnectAttempt: null }
    }

    const header = headerOf(mutated)

    expect(header[0]).toBe('SSH diagnostics aaaa1111')
    expect(header[3]).toBe('Status: auth-failed')
  })

  it('parses back as JSON from inside the fence', () => {
    for (const report of [HEALTHY, EVERY_SECTION_FAILED]) {
      const text = formatSshDiagnosticReport(report)

      expect(text).toContain('```json')
      expect(parseFence(text)).toEqual(report)
    }
  })

  it('is pure — the same report formats identically and is not mutated', () => {
    const before = JSON.stringify(HEALTHY)

    expect(formatSshDiagnosticReport(HEALTHY)).toBe(formatSshDiagnosticReport(HEALTHY))
    expect(JSON.stringify(HEALTHY)).toBe(before)
  })
})
