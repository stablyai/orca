import { describe, expect, it } from 'vitest'
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
        memoryLabel: '512 MB',
        sessionCount: 2,
        runtimeEnvironmentActive: false,
        spaceScanReady: false
      })
    ).toEqual([
      'Resource Manager - 512 MB - 2 terminal sessions',
      'Terminal sessions are grouped by workspace.'
    ])
  })

  it('does not advertise local session navigation for runtime servers', () => {
    expect(
      getResourceManagerTooltipLines({
        memoryLabel: '-',
        sessionCount: 0,
        runtimeEnvironmentActive: true,
        spaceScanReady: true
      })
    ).toEqual([
      'Resource Manager - memory unavailable - 0 terminal sessions',
      'Local terminal sessions are hidden for runtime servers.'
    ])
  })

  it('keeps the trigger label descriptive for screen readers', () => {
    expect(
      getResourceManagerAriaLabel({
        sessionCount: 1,
        runtimeEnvironmentActive: false,
        spaceScanReady: true
      })
    ).toBe('Resource Manager, 1 terminal session, Space scan ready')
  })
})
