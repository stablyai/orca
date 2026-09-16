import { describe, expect, it } from 'vitest'
import { shouldShowOpenWithSubmenu } from './file-explorer-open-with-submenu'

const fileNode = { isDirectory: false }
const directoryNode = { isDirectory: true }

describe('shouldShowOpenWithSubmenu', () => {
  it('shows only for local file rows on the desktop client', () => {
    const previous = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    try {
      expect(shouldShowOpenWithSubmenu(fileNode, null, null)).toBe(true)
      expect(shouldShowOpenWithSubmenu(fileNode, undefined, undefined)).toBe(true)
      expect(shouldShowOpenWithSubmenu(directoryNode, null, null)).toBe(false)
      expect(shouldShowOpenWithSubmenu(fileNode, 'ssh-1', null)).toBe(false)
      expect(shouldShowOpenWithSubmenu(fileNode, null, { activeRuntimeEnvironmentId: 'rt-1' })).toBe(
        false
      )
      // Whitespace-only ids mean no active remote target.
      expect(shouldShowOpenWithSubmenu(fileNode, '  ', { activeRuntimeEnvironmentId: '  ' })).toBe(
        true
      )

      ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
      expect(shouldShowOpenWithSubmenu(fileNode, null, null)).toBe(false)
    } finally {
      ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = previous
    }
  })
})
