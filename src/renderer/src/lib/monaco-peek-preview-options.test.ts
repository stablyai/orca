// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { installMonacoPeekReferencesPreviewOptions } from './monaco-peek-preview-options'

type FakePreviewEditor = Pick<Monaco.editor.ICodeEditor, 'updateOptions'>

type FakeReferenceWidgetInstance = {
  _preview?: FakePreviewEditor
  _fillBody?: (containerElement: HTMLElement) => void
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

function createReferenceWidgetConstructor(hooks: {
  fillBody?: (instance: FakeReferenceWidgetInstance) => void
  revealReference?: (instance: FakeReferenceWidgetInstance) => Promise<unknown>
}): {
  prototype: FakeReferenceWidgetInstance &
    Required<Pick<FakeReferenceWidgetInstance, '_fillBody' | '_revealReference'>>
} {
  return {
    prototype: {
      _fillBody(this: FakeReferenceWidgetInstance): void {
        hooks.fillBody?.(this)
      },
      async _revealReference(this: FakeReferenceWidgetInstance): Promise<unknown> {
        return hooks.revealReference?.(this)
      }
    }
  }
}

function createPreviewEditor(): FakePreviewEditor {
  return { updateOptions: vi.fn() }
}

const peekPreviewOptions = {
  smoothScrolling: false,
  stickyScroll: { enabled: false },
  wordWrap: 'off'
}

describe('installMonacoPeekReferencesPreviewOptions', () => {
  it('updates the embedded preview after ReferenceWidget creates it', () => {
    const preview = createPreviewEditor()
    const referenceWidget = createReferenceWidgetConstructor({
      fillBody(instance) {
        instance._preview = preview
      }
    })

    installMonacoPeekReferencesPreviewOptions(referenceWidget)
    referenceWidget.prototype._fillBody(document.createElement('div'))

    expect(preview.updateOptions).toHaveBeenCalledWith(peekPreviewOptions)
  })

  it('updates the embedded preview before revealing a reference', async () => {
    const calls: string[] = []
    const preview: FakePreviewEditor = {
      updateOptions: vi.fn(() => calls.push('updateOptions'))
    }
    const referenceWidget = createReferenceWidgetConstructor({
      revealReference: async () => {
        calls.push('revealReference')
      }
    })
    referenceWidget.prototype._preview = preview

    installMonacoPeekReferencesPreviewOptions(referenceWidget)
    await referenceWidget.prototype._revealReference('reference')

    expect(calls).toEqual(['updateOptions', 'revealReference', 'updateOptions'])
    expect(preview.updateOptions).toHaveBeenCalledWith(peekPreviewOptions)
  })

  it('skips patching when the private Monaco hooks are missing', () => {
    const referenceWidget: { prototype: FakeReferenceWidgetInstance } = { prototype: {} }

    installMonacoPeekReferencesPreviewOptions(referenceWidget)

    expect(referenceWidget.prototype._fillBody).toBeUndefined()
    expect(referenceWidget.prototype._revealReference).toBeUndefined()
  })

  it('does not wrap ReferenceWidget more than once', async () => {
    const preview = createPreviewEditor()
    const referenceWidget = createReferenceWidgetConstructor({})
    referenceWidget.prototype._preview = preview

    installMonacoPeekReferencesPreviewOptions(referenceWidget)
    installMonacoPeekReferencesPreviewOptions(referenceWidget)
    await referenceWidget.prototype._revealReference('reference')

    expect(preview.updateOptions).toHaveBeenCalledTimes(2)
  })
})
