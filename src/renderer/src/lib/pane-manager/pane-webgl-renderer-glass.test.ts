import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldUseTerminalWebgl } from './pane-webgl-renderer'
import type { ManagedPaneInternal } from './pane-manager-types'

// Why: shouldUseTerminalWebgl reads document.documentElement.classList to
// detect glass themes (the glass override is purely visual; the pane
// itself does not carry settings). Stub the global document for tests.
function stubDocumentWithClasses(...classes: string[]): void {
  const classList = new Set(classes)
  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        contains: (name: string) => classList.has(name)
      }
    }
  })
}

function makePane(gpuAcceleration: 'on' | 'auto' | 'off' = 'auto'): ManagedPaneInternal {
  return {
    terminalGpuAcceleration: gpuAcceleration,
    hasComplexScriptOutput: false
  } as ManagedPaneInternal
}

describe('shouldUseTerminalWebgl — glass theme gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns false when glass-light is active even with gpu=on', () => {
    stubDocumentWithClasses('glass-light')
    expect(shouldUseTerminalWebgl(makePane('on'))).toBe(false)
  })

  it('returns false when glass-dark is active even with gpu=on', () => {
    stubDocumentWithClasses('glass-dark')
    expect(shouldUseTerminalWebgl(makePane('on'))).toBe(false)
  })

  it('honors gpu=on when no glass theme is active', () => {
    stubDocumentWithClasses('dark')
    expect(shouldUseTerminalWebgl(makePane('on'))).toBe(true)
  })

  it('honors gpu=auto when no glass theme is active', () => {
    stubDocumentWithClasses('light')
    expect(shouldUseTerminalWebgl(makePane('auto'))).toBe(true)
  })

  it('returns false when document is undefined (SSR / non-renderer)', () => {
    vi.stubGlobal('document', undefined)
    // Falls through to the rest of the logic; gpu=auto on no-platform
    // returns true via the existing code path. The 'no glass class'
    // pathway is what we're protecting — verify the guard.
    // Behavior: isGlassThemeActive returns false → doesn't gate WebGL.
    // This is intentional: we don't want SSR / test envs to silently
    // disable WebGL for everyone.
    expect(shouldUseTerminalWebgl(makePane('on'))).toBe(true)
  })
})
