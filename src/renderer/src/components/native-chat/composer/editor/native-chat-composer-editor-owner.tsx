import { Editor, type EditorOptions } from '@tiptap/core'
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { subscribeToNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import {
  ephemeralDrafts,
  isNativeChatEditDraft
} from '../../drafts/native-chat-composer-draft-memory'
import { createNativeChatPastedTextHistory } from './native-chat-pasted-text-history'

type HistoryPaths = ReturnType<typeof createNativeChatPastedTextHistory>
type Options = Omit<Partial<EditorOptions>, 'onTransaction'> & {
  onTransaction?: (
    event: Parameters<EditorOptions['onTransaction']>[0],
    historyPaths: HistoryPaths
  ) => void
}
type OwnedEditor = {
  editor: Editor
  historyPaths: HistoryPaths
  selection: EditorSelection
  options: Options
  release: () => void
}

class EditorSelection {
  private userOwned = false
  private appliedPosition: unknown
  claim(): void {
    this.userOwned = true
  }
  isUserOwned(): boolean {
    return this.userOwned
  }
  hasApplied(position: unknown): boolean {
    return this.appliedPosition === position
  }
  markApplied(position: unknown): void {
    this.appliedPosition = position
  }
}

// Tiptap reports an unmounted editor as destroyed too; only these may never mount a view again.
const disposedEditors = new WeakSet<Editor>()

class ComposerEditors {
  private editors = new Map<string, OwnedEditor>()
  private generation = 0

  retain = (): (() => void) => {
    const generation = ++this.generation
    return () => {
      // StrictMode reconnects the owner before this disposal; Activity never disconnects it.
      queueMicrotask(() => {
        if (generation === this.generation) {
          for (const entry of this.editors.values()) {
            entry.release()
            entry.editor.destroy()
          }
          this.editors.clear()
        }
      })
    }
  }

  get(scope: string, options: Options): OwnedEditor {
    const existing = this.editors.get(scope)
    if (existing && !disposedEditors.has(existing.editor)) {
      existing.options = options
      return existing
    }
    // Something outside the owner destroyed it; a composer that reappears gets a live one.
    existing?.release()
    const entry: OwnedEditor = {
      options,
      release: () => {},
      historyPaths: createNativeChatPastedTextHistory(scope),
      selection: new EditorSelection(),
      editor: new Editor({
        ...options,
        // A view exists only while its composer is shown; see NativeChatComposerEditorView.
        element: null,
        onTransaction: (event) => entry.options.onTransaction?.(event, entry.historyPaths),
        onUpdate: (...args) => entry.options.onUpdate?.(...args),
        onSelectionUpdate: (...args) => entry.options.onSelectionUpdate?.(...args)
      })
    }
    entry.editor.on('destroy', () => disposedEditors.add(entry.editor))
    this.editors.set(scope, entry)
    if (isNativeChatEditDraft(scope)) {
      entry.release = subscribeToNativeChatComposerDraft(scope, () => {
        if (!ephemeralDrafts.has(scope)) {
          this.editors.delete(scope)
          entry.release()
          entry.editor.destroy()
        }
      })
    }
    return entry
  }
}

const ComposerEditorOwner = createContext<ComposerEditors | null>(null)

/** Gives the owned editor a view while shown; hidden, it keeps its state but no view or document listeners.
 *  Render before EditorContent so the view exists when EditorContent adopts it. */
export function NativeChatComposerEditorView({ editor }: { editor: Editor }): null {
  useLayoutEffect(() => {
    // One view per editor: Tiptap would replace a live view without destroying it.
    if (disposedEditors.has(editor) || !editor.isDestroyed) {
      return
    }
    editor.mount(document.createElement('div'))
    return () => {
      // Without its stylesheet handle, unmount skips a whole-page `.tiptap` query and leaves the
      // shared stylesheet in place; removing and re-adding it would restyle the page each switch.
      Reflect.set(editor, 'css', null)
      editor.unmount()
    }
  }, [editor])
  return null
}

/** The tab owns editors and their state; only a shown composer gives one a view. */
export function NativeChatComposerEditorOwner({ children }: { children: React.ReactNode }) {
  const [owner] = useState(() => new ComposerEditors())
  useEffect(() => owner.retain(), [owner])
  return <ComposerEditorOwner value={owner}>{children}</ComposerEditorOwner>
}

export function useNativeChatComposerEditor(
  scope: string,
  options: Options
): Pick<OwnedEditor, 'editor' | 'historyPaths' | 'selection'> {
  const owner = useContext(ComposerEditorOwner)
  const local = useMemo(() => ({ scope, editors: new ComposerEditors() }), [scope])
  const entry = (owner ?? local.editors).get(scope, options)
  useEffect(() => (owner ? undefined : local.editors.retain()), [local, owner])
  useLayoutEffect(() => {
    entry.editor.setOptions({ editorProps: entry.options.editorProps })
  })
  return entry
}
