import { describe, expect, it, vi } from 'vitest'
import { isExplorerTreeCoveredByHostMode } from './useFileExplorerKeys'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: vi.fn(), subscribe: vi.fn() })
}))

describe('isExplorerTreeCoveredByHostMode', () => {
  it('disables tree shortcuts while the Host overlay is in the explorer shell', () => {
    const shell = (hasOverlay: boolean) => ({
      querySelector: (selector: string) =>
        hasOverlay && selector === '[data-file-explorer-host-overlay]' ? {} : null
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only querySelector.
    expect(isExplorerTreeCoveredByHostMode(shell(true) as unknown as Element)).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only querySelector.
    expect(isExplorerTreeCoveredByHostMode(shell(false) as unknown as Element)).toBe(false)
    expect(isExplorerTreeCoveredByHostMode(null)).toBe(false)
  })
})
