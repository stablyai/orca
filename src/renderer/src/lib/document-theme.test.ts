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

function createThemeRoot(): {
  classList: FakeClassList
  dataset: Record<string, string | undefined>
} {
  return { classList: new FakeClassList(), dataset: {} }
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

  it('sets dataset.theme for custom theme presets and removes it for default', () => {
    const root = createThemeRoot()

    applyDocumentTheme('dark', { root, themePreset: 'dracula', disableTransitions: false })
    expect(root.dataset.theme).toBe('dracula')
    expect(root.classList.contains('dark')).toBe(true)

    applyDocumentTheme('dark', { root, themePreset: 'nord', disableTransitions: false })
    expect(root.dataset.theme).toBe('nord')

    applyDocumentTheme('dark', { root, themePreset: 'default', disableTransitions: false })
    expect(root.dataset.theme).toBeUndefined()
  })

  it('resolves preset variant according to effective mode in system theme', () => {
    const root = createThemeRoot()

    // System is dark -> catppuccin-mocha
    applyDocumentTheme('system', {
      root,
      themePreset: 'catppuccin-mocha',
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('catppuccin-mocha')
    expect(root.classList.contains('dark')).toBe(true)

    // System is light -> swaps to catppuccin-latte
    applyDocumentTheme('system', {
      root,
      themePreset: 'catppuccin-mocha',
      matchMedia: () => ({ matches: false }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('catppuccin-latte')
    expect(root.classList.contains('light')).toBe(true)

    // System is dark -> material-dark
    applyDocumentTheme('system', {
      root,
      themePreset: 'material-dark',
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('material-dark')
    expect(root.classList.contains('dark')).toBe(true)

    // System is light -> swaps to material-light
    applyDocumentTheme('system', {
      root,
      themePreset: 'material-dark',
      matchMedia: () => ({ matches: false }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('material-light')
    expect(root.classList.contains('light')).toBe(true)

    // System is dark -> liquid-glass-dark
    applyDocumentTheme('system', {
      root,
      themePreset: 'liquid-glass-dark',
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('liquid-glass-dark')
    expect(root.classList.contains('dark')).toBe(true)

    // System is light -> swaps to liquid-glass-light
    applyDocumentTheme('system', {
      root,
      themePreset: 'liquid-glass-dark',
      matchMedia: () => ({ matches: false }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('liquid-glass-light')
    expect(root.classList.contains('light')).toBe(true)

    // Discord dark / light swap
    applyDocumentTheme('system', {
      root,
      themePreset: 'discord-dark',
      matchMedia: () => ({ matches: false }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('discord-light')
    expect(root.classList.contains('light')).toBe(true)

    // Raycast dark / light swap
    applyDocumentTheme('system', {
      root,
      themePreset: 'raycast-dark',
      matchMedia: () => ({ matches: false }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('raycast-light')
    expect(root.classList.contains('light')).toBe(true)

    // Miranda paper / ink swap
    applyDocumentTheme('system', {
      root,
      themePreset: 'miranda-light',
      matchMedia: () => ({ matches: true }),
      disableTransitions: false
    })
    expect(root.dataset.theme).toBe('miranda-dark')
    expect(root.classList.contains('dark')).toBe(true)
  })
})
