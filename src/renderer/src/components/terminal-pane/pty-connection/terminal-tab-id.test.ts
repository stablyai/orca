import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalTabId } from './terminal-tab-id'

describe('resolveTerminalTabId', () => {
  it('maps a unified terminal tab id to its legacy owner id', () => {
    const getTab = vi.fn(() => ({ contentType: 'terminal', entityId: 'legacy-tab' }))

    expect(resolveTerminalTabId({ getTab }, 'unified-tab')).toBe('legacy-tab')
    expect(getTab).toHaveBeenCalledWith('unified-tab')
  })

  it('keeps non-terminal and unknown ids unchanged', () => {
    expect(
      resolveTerminalTabId(
        { getTab: () => ({ contentType: 'editor', entityId: '/tmp/file.ts' }) },
        'editor-tab'
      )
    ).toBe('editor-tab')
    expect(resolveTerminalTabId({}, 'legacy-tab')).toBe('legacy-tab')
  })

  it('keeps an exact terminal owner ahead of a stale unified alias', () => {
    expect(
      resolveTerminalTabId(
        {
          getTab: () => ({ contentType: 'terminal', entityId: 'old-owner' }),
          hasTerminalTab: (tabId) => tabId === 'live-owner'
        },
        'live-owner'
      )
    ).toBe('live-owner')
  })
})
