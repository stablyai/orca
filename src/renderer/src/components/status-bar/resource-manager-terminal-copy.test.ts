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
      'Resource Manager - 512 MB · Σ RSS - 2 terminal sessions',
      'Terminal sessions are grouped by workspace.'
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
      'Resource Manager - memory unavailable - 0 terminal sessions',
      'Space scan ready',
      'No terminal sessions yet.'
    ])
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
