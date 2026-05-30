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

    applyDocumentTheme('dark', false, { root, disableTransitions: false })
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)

    applyDocumentTheme('light', false, { root, disableTransitions: false })
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.classList.contains('light')).toBe(true)
  })

  it('applies system root class from matchMedia', () => {
    const root = createThemeRoot()

    applyDocumentTheme('system', false, {
      root,
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('removes the transition suppression class after two animation frames', () => {
    const root = createThemeRoot()
    const frames = createFrameQueue()

    applyDocumentTheme('dark', false, {
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

  it('does not set glass classes when glassEffect is false', () => {
    const root = createThemeRoot()
    applyDocumentTheme('dark', false, { root, disableTransitions: false, isDarwin: true })
    expect(root.classList.contains('glass-dark')).toBe(false)
    expect(root.classList.contains('glass-light')).toBe(false)
  })

  it('applies glass-light when glassEffect is true and theme resolves to light (macOS)', () => {
    const root = createThemeRoot()
    applyDocumentTheme('light', true, { root, disableTransitions: false, isDarwin: true })
    expect(root.classList.contains('glass-light')).toBe(true)
    expect(root.classList.contains('glass-dark')).toBe(false)
    expect(root.classList.contains('light')).toBe(true)
  })

  it('applies glass-dark when glassEffect is true and theme resolves to dark (macOS)', () => {
    const root = createThemeRoot()
    applyDocumentTheme('dark', true, { root, disableTransitions: false, isDarwin: true })
    expect(root.classList.contains('glass-dark')).toBe(true)
    expect(root.classList.contains('glass-light')).toBe(false)
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('glass + system theme tracks OS preference', () => {
    const root = createThemeRoot()
    // System reports dark
    applyDocumentTheme('system', true, {
      root,
      disableTransitions: false,
      isDarwin: true,
      matchMedia: () => ({ matches: true })
    })
    expect(root.classList.contains('glass-dark')).toBe(true)
    expect(root.classList.contains('glass-light')).toBe(false)

    // System reports light
    applyDocumentTheme('system', true, {
      root,
      disableTransitions: false,
      isDarwin: true,
      matchMedia: () => ({ matches: false })
    })
    expect(root.classList.contains('glass-light')).toBe(true)
    expect(root.classList.contains('glass-dark')).toBe(false)
  })

  it('silently ignores glassEffect on non-macOS hosts', () => {
    const root = createThemeRoot()
    applyDocumentTheme('dark', true, { root, disableTransitions: false, isDarwin: false })
    expect(root.classList.contains('glass-dark')).toBe(false)
    expect(root.classList.contains('glass-light')).toBe(false)
    expect(root.classList.contains('dark')).toBe(true)
  })

  it('clears glass classes when glassEffect flips from on to off', () => {
    const root = createThemeRoot()
    applyDocumentTheme('dark', true, { root, disableTransitions: false, isDarwin: true })
    expect(root.classList.contains('glass-dark')).toBe(true)

    applyDocumentTheme('dark', false, { root, disableTransitions: false, isDarwin: true })
    expect(root.classList.contains('glass-dark')).toBe(false)
    expect(root.classList.contains('glass-light')).toBe(false)
  })

  it('cancels stale transition suppression frames on rapid theme changes', () => {
    const root = createThemeRoot()
    const frames = createFrameQueue()

    applyDocumentTheme('dark', false, {
      root,
      requestAnimationFrame: frames.requestAnimationFrame,
      cancelAnimationFrame: frames.cancelAnimationFrame
    })
    expect(frames.pendingCount()).toBe(1)

    applyDocumentTheme('light', false, {
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
