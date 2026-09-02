import { describe, expect, it, vi } from 'vitest'

// Mirrors resource-memory-metric-copy.test.ts: assert the English source copy
// through the catalog fallback, with placeholders filled the way i18next would.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (match, name: string) => String(options?.[name] ?? match))
}))

import {
  formatTerminalSessionCount,
  getResourceManagerAriaLabel,
  getResourceManagerTooltipLines
} from './resource-manager-terminal-copy'

describe('resource manager terminal copy', () => {
  it('formats terminal session counts with the terminal noun visible', () => {
    expect(formatTerminalSessionCount(1)).toBe('1 terminal session')
    expect(formatTerminalSessionCount(3)).toBe('3 terminal sessions')
  })

  it('points users from the status-bar count back to workspace terminals', () => {
    expect(
      getResourceManagerTooltipLines({
        memoryLabel: '512 MB · Σ RSS',
        sessionCount: 2,
        spaceScanReady: false
      })
    ).toEqual([
      {
        id: 'summary',
        text: 'Resource Manager - 512 MB · Σ RSS - 2 terminal sessions',
        emphasized: false
      },
      {
        id: 'sessions-hint',
        text: 'Terminal sessions are grouped by workspace.',
        emphasized: false
      }
    ])
  })

  it('keeps local session copy active under runtime focus', () => {
    expect(
      getResourceManagerTooltipLines({
        memoryLabel: '-',
        sessionCount: 0,
        spaceScanReady: true
      })
    ).toEqual([
      {
        id: 'summary',
        text: 'Resource Manager - memory unavailable - 0 terminal sessions',
        emphasized: false
      },
      { id: 'space-scan', text: 'Space scan ready', emphasized: true },
      { id: 'sessions-hint', text: 'No terminal sessions yet.', emphasized: false }
    ])
  })

  // Why: the tooltip used to tint this row by matching its English text, so any
  // translated build lost the tint. The flag is what the segment reads now.
  it('flags the space-scan row instead of leaving callers to match its wording', () => {
    const lines = getResourceManagerTooltipLines({
      memoryLabel: '512 MB',
      sessionCount: 1,
      spaceScanReady: true
    })

    expect(lines.filter((line) => line.emphasized).map((line) => line.text)).toEqual([
      'Space scan ready'
    ])
  })

  // Why: the tooltip keys rows by id, so a repeated id would silently drop a row.
  it('gives every tooltip row a unique id to key on', () => {
    for (const spaceScanReady of [false, true]) {
      for (const sessionCount of [0, 1, 4]) {
        const ids = getResourceManagerTooltipLines({
          memoryLabel: '512 MB',
          sessionCount,
          spaceScanReady
        }).map((line) => line.id)

        expect(new Set(ids).size).toBe(ids.length)
      }
    }
  })

  it('keeps the trigger label descriptive for screen readers', () => {
    expect(
      getResourceManagerAriaLabel({
        sessionCount: 1,
        spaceScanReady: true
      })
    ).toBe('Resource Manager, 1 terminal session, Space scan ready')
  })
})
