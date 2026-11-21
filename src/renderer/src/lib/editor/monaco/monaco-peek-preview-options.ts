import type * as Monaco from 'monaco-editor'
import { ReferenceWidget as MonacoReferenceWidget } from 'monaco-editor/esm/vs/editor/contrib/gotoSymbol/browser/peek/referencesWidget.js'

type PeekPreviewEditor = Pick<Monaco.editor.ICodeEditor, 'updateOptions'>

const PEEK_REFERENCES_PREVIEW_OPTIONS: Monaco.editor.IEditorOptions = {
  smoothScrolling: false,
  stickyScroll: { enabled: false },
  wordWrap: 'off'
}

type ReferenceWidgetInstance = {
  _preview?: PeekPreviewEditor
  _fillBody?: (containerElement: HTMLElement) => void
  _revealReference?: (...args: unknown[]) => Promise<unknown>
}

type ReferenceWidgetConstructor = {
  prototype: ReferenceWidgetInstance & {
    __orcaPeekPreviewOptionsInstalled?: true
  }
}

function applyPeekReferencesPreviewOptions(editor: PeekPreviewEditor | undefined): void {
  // Embedded editors inherit full-editor options; transient Peek readers need no wrap/scroll widgets.
  editor?.updateOptions(PEEK_REFERENCES_PREVIEW_OPTIONS)
}

export function installMonacoPeekReferencesPreviewOptions(
  referenceWidget: ReferenceWidgetConstructor = MonacoReferenceWidget as unknown as ReferenceWidgetConstructor
): void {
  const prototype = referenceWidget.prototype
  if (prototype.__orcaPeekPreviewOptionsInstalled) {
    return
  }

  const originalFillBody = prototype._fillBody
  const originalRevealReference = prototype._revealReference
  // Private Monaco members can disappear on upgrade; keep defaults if patching is unsupported.
  if (typeof originalFillBody !== 'function' || typeof originalRevealReference !== 'function') {
    return
  }

  prototype._fillBody = function fillBodyWithPeekPreviewOptions(
    this: ReferenceWidgetInstance,
    containerElement: HTMLElement
  ): void {
    originalFillBody.call(this, containerElement)
    applyPeekReferencesPreviewOptions(this._preview)
  }

  prototype._revealReference = async function revealReferenceWithPeekPreviewOptions(
    this: ReferenceWidgetInstance,
    ...args: unknown[]
  ): Promise<unknown> {
    applyPeekReferencesPreviewOptions(this._preview)
    try {
      return await originalRevealReference.apply(this, args)
    } finally {
      applyPeekReferencesPreviewOptions(this._preview)
    }
  }

  prototype.__orcaPeekPreviewOptionsInstalled = true
}
