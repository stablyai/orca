import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceSidebarPosition } from './workspace-sidebar-position'

describe('normalizeWorkspaceSidebarPosition', () => {
  it('keeps the two valid edges', () => {
    expect(normalizeWorkspaceSidebarPosition('left')).toBe('left')
    expect(normalizeWorkspaceSidebarPosition('right')).toBe('right')
  })

  it('resolves anything else to the left default', () => {
    for (const value of [undefined, null, '', 'Right', 'top', 1, {}]) {
      expect(normalizeWorkspaceSidebarPosition(value)).toBe('left')
    }
  })
})
