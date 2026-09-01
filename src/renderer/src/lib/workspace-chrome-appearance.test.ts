import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  applyWorkspaceChromeStyleVariables,
  resolveWorkspaceChromeStyleVariables
} from './workspace-chrome-appearance'

/** Settings fixture in match-terminal mode unless overridden. */
function settings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    ...overrides
  }
}

describe('resolveWorkspaceChromeStyleVariables', () => {
  it('keeps the app-theme chrome surface by default', () => {
    expect(resolveWorkspaceChromeStyleVariables(settings(), true)).toBeUndefined()
    expect(resolveWorkspaceChromeStyleVariables(null, true)).toBeUndefined()
  })

  it('treats a missing mode from older persisted settings as default', () => {
    expect(
      resolveWorkspaceChromeStyleVariables(
        settings({ workspaceChromeAppearanceMode: undefined }),
        true
      )
    ).toBeUndefined()
  })

  it('paints the titlebar hook and card with the terminal background and re-derives text tokens', () => {
    const vars = resolveWorkspaceChromeStyleVariables(
      settings({
        workspaceChromeAppearanceMode: 'match-terminal',
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8'
        }
      }),
      true
    )

    expect(vars).toMatchObject({
      '--bg-titlebar': '#101820',
      '--card': '#101820',
      '--background': '#101820',
      '--foreground': '#f0f4f8',
      '--card-foreground': '#f0f4f8'
    })
    expect(vars?.['--muted-foreground']).toBe('color-mix(in srgb, #f0f4f8 62%, #101820)')
    expect(vars?.['--border']).toBe('color-mix(in srgb, #f0f4f8 7%, #101820)')
    expect(vars?.['--accent']).toBe('color-mix(in srgb, #f0f4f8 9%, #101820)')
    expect(vars?.['--popover']).toBe('color-mix(in srgb, #f0f4f8 4%, #101820)')
  })

  it('re-derives both sidebar token families so side panels follow too', () => {
    const vars = resolveWorkspaceChromeStyleVariables(
      settings({
        workspaceChromeAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#101820', foreground: '#f0f4f8' }
      }),
      true
    )

    expect(vars).toMatchObject({
      '--sidebar': '#101820',
      '--sidebar-foreground': '#f0f4f8',
      '--worktree-sidebar': '#101820',
      '--worktree-sidebar-foreground': '#f0f4f8'
    })
    expect(vars?.['--sidebar-accent']).toBe(vars?.['--worktree-sidebar-accent'])
  })

  it('falls back to the selected builtin terminal theme when no overrides are set', () => {
    const dark = resolveWorkspaceChromeStyleVariables(
      settings({ workspaceChromeAppearanceMode: 'match-terminal' }),
      true
    )
    const light = resolveWorkspaceChromeStyleVariables(
      settings({
        workspaceChromeAppearanceMode: 'match-terminal',
        terminalUseSeparateLightTheme: true,
        theme: 'light'
      }),
      false
    )

    expect(dark?.['--bg-titlebar']).toMatch(/^#[0-9a-f]{6}$/i)
    expect(light?.['--bg-titlebar']).toMatch(/^#[0-9a-f]{6}$/i)
    expect(dark?.['--bg-titlebar']).not.toBe(light?.['--bg-titlebar'])
  })

  it('paints editor panes with the terminal background and exposes its syntax palette', () => {
    const vars = resolveWorkspaceChromeStyleVariables(
      settings({
        workspaceChromeAppearanceMode: 'match-terminal',
        terminalColorOverrides: {
          background: '#101820',
          foreground: '#f0f4f8',
          magenta: '#ff00ff',
          green: '#00ff00'
        }
      }),
      true
    )

    expect(vars?.['--editor-surface']).toBe('#101820')
    expect(vars?.['--syntax-keyword']).toBe('#ff00ff')
    expect(vars?.['--syntax-string']).toBe('#00ff00')
  })

  it('honors terminal background opacity', () => {
    const vars = resolveWorkspaceChromeStyleVariables(
      settings({
        workspaceChromeAppearanceMode: 'match-terminal',
        terminalColorOverrides: { background: '#123456' },
        terminalBackgroundOpacity: 0.5
      }),
      true
    )

    expect(vars?.['--bg-titlebar']).toBe('rgba(18, 52, 86, 0.5)')
    expect(vars?.['--card']).toBe('rgba(18, 52, 86, 0.5)')
  })
})

describe('applyWorkspaceChromeStyleVariables', () => {
  /** Minimal CSSStyleDeclaration stand-in recording set/removed properties. */
  function fakeStyle() {
    const props = new Map<string, string>()
    return {
      props,
      setProperty: (key: string, value: string) => void props.set(key, value),
      removeProperty: (key: string) => {
        props.delete(key)
        return ''
      }
    }
  }

  it('sets every variable and reports the applied keys', () => {
    const style = fakeStyle()
    const keys = applyWorkspaceChromeStyleVariables(
      style,
      { '--card': '#111', '--ring': '#222' },
      []
    )

    expect(keys).toEqual(['--card', '--ring'])
    expect([...style.props]).toEqual([
      ['--card', '#111'],
      ['--ring', '#222']
    ])
  })

  it('removes previously applied keys that the next set no longer contains', () => {
    const style = fakeStyle()
    let keys = applyWorkspaceChromeStyleVariables(style, { '--card': '#111', '--ring': '#222' }, [])
    keys = applyWorkspaceChromeStyleVariables(style, { '--card': '#333' }, keys)

    expect(keys).toEqual(['--card'])
    expect([...style.props]).toEqual([['--card', '#333']])

    expect(applyWorkspaceChromeStyleVariables(style, undefined, keys)).toEqual([])
    expect(style.props.size).toBe(0)
  })
})
