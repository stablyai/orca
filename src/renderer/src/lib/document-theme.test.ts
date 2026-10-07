import { describe, expect, it } from 'vitest'
import {
  applyDocumentTheme,
  resolveDocumentTheme,
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

  [Symbol.iterator](): Iterator<string> {
    return this.tokens.values()
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
  it('resolves explicit theme preferences', () => {
    expect(resolveDocumentTheme('dark')).toBe(true)
    expect(resolveDocumentTheme('light')).toBe(false)
  })

  it('resolves system from matchMedia', () => {
    expect(resolveDocumentTheme('system', () => ({ matches: true }))).toBe(true)
    expect(resolveDocumentTheme('system', () => ({ matches: false }))).toBe(false)
  })

  it('applies dark and light root classes', () => {
    const root = createThemeRoot()

    applyDocumentTheme('dark', { root, disableTransitions: false })
    expect(root.classList.contains('dark')).toBe(true)

    applyDocumentTheme('light', { root, disableTransitions: false })
    expect(root.classList.contains('dark')).toBe(false)
  })

  it('applies system root class from matchMedia', () => {
    const root = createThemeRoot()

    applyDocumentTheme('system', {
      root,
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.classList.contains('dark')).toBe(true)
  })

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

  it('replaces interface theme classes when themes are given', () => {
    const root = createThemeRoot()

    applyDocumentTheme('dark', {
      root,
      disableTransitions: false,
      interfaceThemes: { dark: 'catppuccin-mocha', light: 'default' }
    })
    expect(root.classList.contains('ui-dark-catppuccin-mocha')).toBe(true)
    expect(root.classList.contains('ui-light-default')).toBe(true)

    applyDocumentTheme('dark', {
      root,
      disableTransitions: false,
      interfaceThemes: { dark: 'catppuccin-frappe', light: 'catppuccin-latte' }
    })
    expect([...root.classList].filter((token) => token.startsWith('ui-')).sort()).toEqual([
      'ui-dark-catppuccin-frappe',
      'ui-light-catppuccin-latte'
    ])
  })

  it('leaves interface theme classes alone when themes are omitted', () => {
    const root = createThemeRoot()

    applyDocumentTheme('dark', {
      root,
      disableTransitions: false,
      interfaceThemes: { dark: 'catppuccin-mocha', light: 'catppuccin-latte' }
    })
    applyDocumentTheme('light', { root, disableTransitions: false })

    expect(root.classList.contains('ui-dark-catppuccin-mocha')).toBe(true)
    expect(root.classList.contains('ui-light-catppuccin-latte')).toBe(true)
  })
})
