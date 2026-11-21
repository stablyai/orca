import { Editor, type EditorOptions } from '@tiptap/core'
import { redoDepth, undoDepth } from '@tiptap/pm/history'
import {
  isNativeChatViewTabOpen,
  type NativeChatViewTab
} from '../../pane/ownership/native-chat-view-memory'
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

  retain = (release?: {
    keep: (editor: Editor) => boolean
    done: (editors: ComposerEditors) => void
  }): (() => void) => {
    const generation = ++this.generation
    return () => {
      // StrictMode reconnects the owner before this disposal; Activity never disconnects it.
      queueMicrotask(() => {
        if (generation !== this.generation) {
          return
        }
        for (const [scope, entry] of this.editors) {
          if (!release?.keep(entry.editor)) {
            this.editors.delete(scope)
            entry.release()
            entry.editor.destroy()
          }
        }
        release?.done(this)
      })
    }
  }

  get size(): number {
    return this.editors.size
  }

  /** Every kept editor is empty, so only undo history is left to lose. */
  holdsNoText(): boolean {
    return [...this.editors.values()].every((entry) => entry.editor.isEmpty)
  }

  destroyAll(): void {
    for (const entry of this.editors.values()) {
      entry.release()
      entry.editor.destroy()
    }
    this.editors.clear()
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

// Why: a chat view released to bound memory keeps only editors with a draft or undo history, so undo and
// selection survive. Drafts are the user's text and stay; editors left with only undo history are capped.
const keptEditorsByTab = new Map<string, ComposerEditors>()
// Tabs whose kept editors hold no text, oldest first; drafts are the user's text and are never capped.
const undoOnlyTabs = new Set<string>()
const MAX_KEPT_UNDO_ONLY = 8

const keepsEditor = (editor: Editor): boolean =>
  !editor.isEmpty || undoDepth(editor.state) > 0 || redoDepth(editor.state) > 0

function keepEditors(tabId: string, editors: ComposerEditors): void {
  keptEditorsByTab.set(tabId, editors)
  if (!editors.holdsNoText()) {
    return
  }
  undoOnlyTabs.add(tabId)
  if (undoOnlyTabs.size > MAX_KEPT_UNDO_ONLY) {
    for (const oldest of undoOnlyTabs) {
      undoOnlyTabs.delete(oldest)
      keptEditorsByTab.get(oldest)?.destroyAll()
      keptEditorsByTab.delete(oldest)
      break
    }
  }
}

function takeKeptEditors(tabId: string): void {
  keptEditorsByTab.delete(tabId)
  undoOnlyTabs.delete(tabId)
}

/** Closing a chat tab ends the editors its released view kept. */
export function releaseNativeChatComposerEditors(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    keptEditorsByTab.get(tabId)?.destroyAll()
    takeKeptEditors(tabId)
  }
}

/** The tab owns editors and their state; only a shown composer gives one a view. */
export function NativeChatComposerEditorOwner({
  viewTab,
  children
}: {
  /** Set for a chat view that can be released while its tab stays open. */
  viewTab?: NativeChatViewTab
  children: React.ReactNode
}) {
  const [owner] = useState(
    () => (viewTab ? keptEditorsByTab.get(viewTab.tabId) : undefined) ?? new ComposerEditors()
  )
  useEffect(() => {
    if (viewTab && keptEditorsByTab.get(viewTab.tabId) === owner) {
      takeKeptEditors(viewTab.tabId)
    }
    return owner.retain(
      viewTab
        ? {
            // A closed tab's editors end with it; a released view of an open tab keeps what it can't rebuild.
            keep: (editor) => isNativeChatViewTabOpen(viewTab) && keepsEditor(editor),
            done: (editors) => {
              if (editors.size > 0) {
                keepEditors(viewTab.tabId, editors)
              }
            }
          }
        : undefined
    )
  }, [owner, viewTab])
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
