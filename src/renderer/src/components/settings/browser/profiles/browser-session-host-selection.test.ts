import { describe, expect, it } from 'vitest'
import { resolveAvailableBrowserSessionHostId } from './browser-session-host-selection'

const options = [{ id: 'local' as const }, { id: 'runtime:linux-3' as const }]

describe('browser session host selection', () => {
  it('keeps an available transient override', () => {
    expect(resolveAvailableBrowserSessionHostId(options, 'runtime:linux-3', 'local')).toBe(
      'runtime:linux-3'
    )
  })

  it('falls back from a removed override to the available focused host', () => {
    expect(resolveAvailableBrowserSessionHostId(options, 'runtime:windows-2', 'local')).toBe(
      'local'
    )
  })

  it('falls back to the first option when both selected hosts are unavailable', () => {
    expect(
      resolveAvailableBrowserSessionHostId(options, 'runtime:windows-2', 'runtime:missing-default')
    ).toBe('local')
  })

  it('falls back to local when no host option is available', () => {
    expect(
      resolveAvailableBrowserSessionHostId([], 'runtime:windows-2', 'runtime:missing-default')
    ).toBe('local')
  })
})
