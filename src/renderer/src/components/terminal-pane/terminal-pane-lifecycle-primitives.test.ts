import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTerminalUrlTooltip } from './terminal-pane-lifecycle-primitives'

describe('formatTerminalUrlTooltip', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the registered-app hint for custom schemes', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    await expect(
      formatTerminalUrlTooltip('obsidian://open?vault=notes', 'http hint', { kind: 'local' })
    ).resolves.toBe('obsidian://open?vault=notes (⌘+click to open in the registered app)')
  })
})
