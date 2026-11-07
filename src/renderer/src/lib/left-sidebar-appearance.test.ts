import { describe, expect, it } from 'vitest'
import {
  resolveLeftSidebarStyleVariables,
  tintedSidebarHostPillOutlineMix
} from './left-sidebar-appearance'
import type { ColorProbe } from './plugin-theme-tokens'

const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) {
    return null
  }
  const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4), 1]
}

const tinted = {
  leftSidebarAppearanceMode: 'tinted' as const,
  leftSidebarTintColor: '#18181b',
  leftSidebarTintOpacity: 0.08
}

describe('host pill outline in the tinted left sidebar', () => {
  it('raises the outline to 2:1 on the selected wash when the app text is only 4.5:1', () => {
    // #919191 on #2a2a2a under the default 8% tint: 40% is 1.6:1 on the wash, 53% is 2:1.
    const app = { foreground: '#919191', background: '#2a2a2a', base: 'dark' as const }
    expect(tintedSidebarHostPillOutlineMix(tinted, app, probe)).toBe(53)
  })

  it("keeps Orca's 40% outline over Orca's dark colors", () => {
    const app = { foreground: '#f0f0f0', background: '#0a0a0a', base: 'dark' as const }
    expect(tintedSidebarHostPillOutlineMix(tinted, app, probe)).toBe(40)
  })
})

describe('left sidebar theme selection tokens', () => {
  it('preserves theme variables when tint opacity is zero', () => {
    expect(
      resolveLeftSidebarStyleVariables({ ...tinted, leftSidebarTintOpacity: 0 })
    ).toBeUndefined()
  })

  it('preserves the theme host pill outline when tint opacity is zero', () => {
    const app = { foreground: '#919191', background: '#2a2a2a', base: 'dark' as const }
    expect(
      tintedSidebarHostPillOutlineMix({ ...tinted, leftSidebarTintOpacity: 0 }, app, probe)
    ).toBeNull()
  })

  it('still applies a nonzero custom tint', () => {
    const settings = { ...tinted, leftSidebarTintOpacity: 0.2 }
    expect(resolveLeftSidebarStyleVariables(settings)?.['--worktree-sidebar']).toBe(
      'color-mix(in srgb, #18181b 20%, var(--background))'
    )
  })
})
