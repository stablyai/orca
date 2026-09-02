import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveRightSidebarStyleVariables } from './sidebar-appearance'

describe('resolveRightSidebarStyleVariables', () => {
  it('treats persisted profiles without a right-sidebar mode as default', () => {
    const settings = getDefaultSettings(tmpdir())
    delete settings.rightSidebarAppearanceMode

    expect(resolveRightSidebarStyleVariables(settings, true)).toBeUndefined()
  })

  it('does not leak worktree-sidebar tokens into the right sidebar', () => {
    const vars = resolveRightSidebarStyleVariables(
      {
        ...getDefaultSettings(tmpdir()),
        rightSidebarAppearanceMode: 'match-terminal',
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      },
      true
    )

    expect(vars).toMatchObject({
      '--sidebar': '#101820',
      '--sidebar-foreground': '#f0f4f8',
      '--background': '#101820',
      '--foreground': '#f0f4f8'
    })
    expect(vars).not.toHaveProperty('--worktree-sidebar')
  })

  it('uses independent right-sidebar tint settings', () => {
    const vars = resolveRightSidebarStyleVariables(
      {
        ...getDefaultSettings(tmpdir()),
        leftSidebarTintColor: '#ff0000',
        leftSidebarTintOpacity: 0.3,
        rightSidebarAppearanceMode: 'tinted',
        rightSidebarTintColor: '#336699',
        rightSidebarTintOpacity: 0.125
      },
      true
    )

    expect(vars?.['--sidebar']).toBe('color-mix(in srgb, #336699 12.5%, var(--background))')
  })
})
