import { describe, expect, it } from 'vitest'
import {
  applyCachedPluginAppTheme,
  applyDocumentTheme,
  applyPluginAppTheme,
  readCachedPluginAppTheme,
  THEME_TRANSITION_DISABLED_CLASS
} from './document-theme'

class FakeClassList {
  private readonly tokens = new Set<string>()

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.tokens.add(token)
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.tokens.delete(token)
    }
  }

  toggle(token: string, force?: boolean): boolean {
    if (force === true) {
      this.tokens.add(token)
      return true
    }
    if (force === false) {
      this.tokens.delete(token)
      return false
    }
    if (this.tokens.has(token)) {
      this.tokens.delete(token)
      return false
    }
    this.tokens.add(token)
    return true
  }

  contains(token: string): boolean {
    return this.tokens.has(token)
  }
}

function createThemeRoot(): { classList: FakeClassList } {
  return { classList: new FakeClassList() }
}

function createFrameQueue(): {
  requestAnimationFrame: (callback: FrameRequestCallback) => number
  cancelAnimationFrame: (handle: number) => void
  flushNextFrame: () => void
  pendingCount: () => number
} {
  let nextHandle = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  return {
    requestAnimationFrame: (callback) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    cancelAnimationFrame: (handle) => {
      callbacks.delete(handle)
    },
    flushNextFrame: () => {
      const [handle, callback] = callbacks.entries().next().value ?? []
      if (handle === undefined || !callback) {
        return
      }
      callbacks.delete(handle)
      callback(0)
    },
    pendingCount: () => callbacks.size
  }
}

describe('document theme', () => {
  it('removes the transition suppression class after two animation frames', () => {
    const root = createThemeRoot()
    const frames = createFrameQueue()

    applyDocumentTheme('dark', {
      root,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    })

    expect(root.classList.contains(THEME_TRANSITION_DISABLED_CLASS)).toBe(true)

    frames.flushNextFrame()
    expect(root.classList.contains(THEME_TRANSITION_DISABLED_CLASS)).toBe(true)

    frames.flushNextFrame()
    expect(root.classList.contains(THEME_TRANSITION_DISABLED_CLASS)).toBe(false)
  })

  it('cancels stale transition suppression frames on rapid theme changes', () => {
    const root = createThemeRoot()
    const frames = createFrameQueue()

    applyDocumentTheme('dark', {
      root,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    })
    expect(frames.pendingCount()).toBe(1)

    applyDocumentTheme('light', {
      root,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    })
    expect(frames.pendingCount()).toBe(1)

    frames.flushNextFrame()
    expect(root.classList.contains(THEME_TRANSITION_DISABLED_CLASS)).toBe(true)
    expect(frames.pendingCount()).toBe(1)

    frames.flushNextFrame()
    expect(root.classList.contains(THEME_TRANSITION_DISABLED_CLASS)).toBe(false)
    expect(frames.pendingCount()).toBe(0)
  })
})

describe('applyPluginAppTheme', () => {
  function fakeRoot() {
    const properties = new Map<string, string>()
    return {
      properties,
      style: {
        setProperty: (name: string, value: string | null) => {
          properties.set(name, value ?? '')
        },
        removeProperty: (name: string) => {
          const previous = properties.get(name) ?? ''
          properties.delete(name)
          return previous
        }
      }
    }
  }
  function memoryStorage(): Storage {
    const values = new Map<string, string>()
    return {
      get length() {
        return values.size
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => {
        values.delete(key)
      },
      setItem: (key, value) => {
        values.set(key, value)
      }
    }
  }
  // Test probe: #rrggbb or #rrggbbaa.
  const probe = (value: string) => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(value)
    if (!match) {
      return null
    }
    const [r = 0, g = 0, b = 0] = match.slice(1, 4).map((hex) => Number.parseInt(hex, 16))
    return [r, g, b, Number.parseInt(match[4] ?? 'ff', 16) / 255] as const
  }
  // Orca's dark built-ins, as the document would report them.
  const darkBuiltIns = () => ({
    '--background': '#0a0a0a',
    '--foreground': '#fafafa',
    '--muted-foreground': '#a1a1a1',
    '--border': '#ffffff12',
    '--ring': '#737373'
  })
  const options = (root = fakeRoot()) => ({ root, probe, builtIns: darkBuiltIns, storage: null })
  const theme = (tokens: Record<string, string>) => ({
    id: 'plugin:samples.midnight/midnight' as const,
    revision: 'r1',
    pluginKey: 'samples.midnight',
    pluginName: 'Midnight',
    label: 'Midnight',
    base: 'dark' as const,
    tokens
  })
  const painted = (tokens: Record<string, string>) => {
    const root = fakeRoot()
    applyPluginAppTheme(theme(tokens), options(root))
    return Object.fromEntries(root.properties)
  }

  it('overlays tokens, drops ones a new theme stops setting, and restores built-ins on removal', () => {
    const root = fakeRoot()
    applyPluginAppTheme(theme({ '--background': '#000000', '--border': '#111111' }), options(root))
    expect(Object.fromEntries(root.properties)).toEqual({
      '--background': '#000000',
      '--border': '#111111'
    })
    applyPluginAppTheme(theme({ '--background': '#222222' }), options(root))
    expect(Object.fromEntries(root.properties)).toEqual({ '--background': '#222222' })
    applyPluginAppTheme(null, options(root))
    expect(root.properties.size).toBe(0)
  })

  it('checks contrast on the effective set, so dropping one pair cannot expose another', () => {
    // White background passes with black text, but fails against muted text; dropping the
    // background leaves black text on the dark built-in background, so that drops too.
    expect(
      painted({
        '--background': '#ffffff',
        '--foreground': '#000000',
        '--muted-foreground': '#ffffff'
      })
    ).toEqual({})
  })

  it('checks plugin colors against the built-ins they sit on', () => {
    // A light plugin surface would put the dark built-in light text on near-white.
    expect(painted({ '--background': '#f4f4f4' })).toEqual({})
    expect(painted({ '--background': '#151520' })).toEqual({ '--background': '#151520' })
  })

  it('keeps text readable on the editor surface notebooks paint on', () => {
    const tokens = { '--background': '#000000', '--foreground': '#ffffff' }
    expect(painted({ ...tokens, '--editor-surface': '#ffffff' })).not.toHaveProperty(
      '--editor-surface'
    )
    expect(painted({ ...tokens, '--editor-surface': '#111111' })).toHaveProperty(
      '--editor-surface',
      '#111111'
    )
  })

  it('rejects invisible rings and borders in any spelling', () => {
    expect(
      painted({ '--ring': '#0a0a0a', '--border': '#00000000', '--input': '#ffffff03' })
    ).toEqual({})
    expect(painted({ '--ring': '#ff2bd6', '--border': '#ffffff1a' })).toEqual({
      '--ring': '#ff2bd6',
      '--border': '#ffffff1a'
    })
  })

  it('drops only the status or link color that fails, never the shared surface', () => {
    const sidebar = { '--sidebar': '#202020', '--sidebar-foreground': '#ffffff' }
    expect(
      painted({
        ...sidebar,
        '--git-decoration-ignored': '#303030',
        '--git-decoration-added': '#4ec95a'
      })
    ).toEqual({ ...sidebar, '--git-decoration-added': '#4ec95a' })
    expect(painted({ '--editor-surface': '#151515', '--text-link': '#1a1a40' })).toEqual({
      '--editor-surface': '#151515'
    })
  })

  it('checks a translucent row as painted over the sidebar it tints', () => {
    const sidebar = { '--worktree-sidebar': '#202020', '--worktree-sidebar-foreground': '#f0f0f0' }
    expect(painted({ ...sidebar, '--worktree-sidebar-active': '#ffffff1a' })).toEqual({
      ...sidebar,
      '--worktree-sidebar-active': '#ffffff1a'
    })
    expect(painted({ ...sidebar, '--worktree-sidebar-active': '#ffffffd0' })).toEqual(sidebar)
  })

  it('checks half of a pair against what main.css paints for the other half', () => {
    // The badge text falls back to --muted-foreground, which this badge would hide.
    expect(painted({ '--accent': '#303030', '--host-badge': '#a1a1a1' })).toEqual({
      '--accent': '#303030'
    })
    // The inactive tab follows --card, so its text is checked on the theme's card.
    expect(painted({ '--card': '#202020', '--tab-inactive-foreground': '#262626' })).toEqual({
      '--card': '#202020'
    })
  })

  it('checks omitted surfaces as main.css paints them in this mode', () => {
    // A bright hue makes its 20% added-line tint unreadable, so the hue itself is dropped.
    const dim = {
      '--background': '#333333',
      '--editor-surface': '#333333',
      '--foreground': '#cccccc'
    }
    expect(painted({ ...dim, '--diff-added': '#ffffff' })).toEqual(dim)
    // A tint the theme set itself takes the blame alone.
    expect(
      painted({ ...dim, '--diff-added': '#3ddc84', '--diff-added-background': '#ffffff' })
    ).toEqual({ ...dim, '--diff-added': '#3ddc84' })
    // Bubble text is chat's mixed foreground, not raw --foreground.
    const black = { '--background': '#000000', '--foreground': '#ffffff' }
    expect(painted({ ...black, '--chat-user-message': '#727272' })).toEqual(black)
    // Dark badges paint --accent at 80%.
    const sidebar = { '--worktree-sidebar': '#000000', '--worktree-sidebar-foreground': '#ffffff' }
    expect(
      painted({
        ...sidebar,
        '--accent': '#ffffff',
        '--accent-foreground': '#000000',
        '--host-badge-foreground': '#767676'
      })
    ).toEqual({ ...sidebar, '--accent': '#ffffff', '--accent-foreground': '#000000' })
  })

  it('keeps the startup cache tied to the theme id and revision until cleared', () => {
    const storage = memoryStorage()
    applyPluginAppTheme(theme({ '--background': '#101018' }), { ...options(), storage })
    expect(readCachedPluginAppTheme(storage)).toEqual({
      id: 'plugin:samples.midnight/midnight',
      revision: 'r1',
      base: 'dark',
      tokens: { '--background': '#101018' }
    })
    const startup = fakeRoot()
    const cached = readCachedPluginAppTheme(storage)
    if (cached) {
      applyCachedPluginAppTheme(cached, { root: startup, probe, builtIns: darkBuiltIns })
    }
    expect(startup.properties.get('--background')).toBe('#101018')

    applyPluginAppTheme(null, { ...options(), storage })
    expect(readCachedPluginAppTheme(storage)).toBeNull()
  })
})
