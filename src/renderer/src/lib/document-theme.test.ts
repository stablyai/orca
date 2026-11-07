import { describe, expect, it } from 'vitest'
import { applyPluginAppTheme } from './document-theme'
import type { ColorProbe } from './plugin-theme-tokens'

const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) {
    return null
  }
  const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4), 1]
}

function paintedOutlineMix(sidebar: string, sidebarForeground: string): string | undefined {
  const painted = new Map<string, string>()
  const root = {
    style: {
      setProperty: (token: string, value: string) => void painted.set(token, value),
      removeProperty: (token: string) => (painted.delete(token), '')
    }
  }
  applyPluginAppTheme(
    {
      id: 'plugin:test/dim',
      revision: 'r1',
      base: 'dark',
      tokens: {
        '--worktree-sidebar': sidebar,
        '--worktree-sidebar-foreground': sidebarForeground
      }
    },
    { root, probe, builtIns: () => ({}), storage: null }
  )
  return painted.get('--worktree-host-pill-outline-mix')
}

describe('host pill outline on the selected workspace card', () => {
  it('raises the outline to 2:1 on the selected wash when sidebar text is only 4.5:1', () => {
    // #919191 on #2a2a2a is 4.55:1; at 40% the outline is 1.6:1 on the 10% wash, at 54% 2:1.
    expect(paintedOutlineMix('#2a2a2a', '#919191')).toBe('54%')
  })

  it("keeps Orca's 40% outline when the sidebar text is bright enough", () => {
    expect(paintedOutlineMix('#2a2a2a', '#f0f0f0')).toBe('40%')
  })
})
