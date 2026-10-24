// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { createInstantHoverDelegate } from 'monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js'

// Guards config/patches/monaco-editor@0.55.1.patch: unpatched 0.55.1 leaves Monaco's global hover
// delegate factory bound to a diff editor's child instantiation service after that diff closes.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('monaco-editor diff editor hover delegate factory patch', () => {
  it('keeps creating hover delegates after a diff editor is disposed', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    // Why: happy-dom has no 2D canvas; Monaco only reads backing-store pixel ratios off it here.
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({})
    })
    const editor = monaco.editor.create(document.createElement('div'), { value: 'a' })
    const diffEditor = monaco.editor.createDiffEditor(document.createElement('div'))

    diffEditor.dispose()

    // Why: every ActionBar a still-open editor builds later (suggest status bar, find widget) does this.
    expect(() => createInstantHoverDelegate().dispose()).not.toThrow()
    editor.dispose()
  })
})
