import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { reconcileRichMarkdownBlockSource } from './rich-markdown-block-source'
import {
  reconcileSerializedMarkdown,
  restoreMarkdownSourceEol
} from './rich-markdown-source-reconcile'

export type RichMarkdownReconcileRefs = {
  /** Source-style baseline, advanced by each serialization commit. */
  originalSourceRef: MutableRefObject<string>
  /** Canonical serialization of `originalSourceRef` (getMarkdown of the unedited doc). */
  baseCanonicalRef: MutableRefObject<string>
  /** Last reconciled output; gates external-change reload echoes. */
  lastCommittedMarkdownRef: MutableRefObject<string>
}

export type RichMarkdownSerializationCommit = {
  /** Bytes to persist to disk (reconciled, or last committed on a torn-down editor). */
  markdown: string
  /** False when the editor was torn down before serializing (refs left untouched). */
  didSerialize: boolean
}

/** Reconcile every serialized edit toward source style and advance refs together for the next incremental edit. */
export function commitRichMarkdownSerialization(
  editor: Editor | null,
  refs: RichMarkdownReconcileRefs,
  roundTrip: (markdown: string) => string | null
): RichMarkdownSerializationCommit {
  let edited: string | undefined
  try {
    edited = editor?.getMarkdown()
  } catch {
    // Destruction between scheduling and serialization must not crash save/restart flushing.
    edited = undefined
  }
  if (edited === undefined) {
    return { markdown: refs.lastCommittedMarkdownRef.current, didSerialize: false }
  }

  let reconciled: string
  try {
    reconciled = reconcileSerializedMarkdown({
      originalSource: refs.originalSourceRef.current,
      baseCanonical: refs.baseCanonicalRef.current,
      edited,
      roundTrip
    })
  } catch (error) {
    // Why: style reconciliation is best-effort; preserve content and source EOL when it fails.
    console.error('[editor] markdown reconcile failed; falling back to canonical output', error)
    reconciled = restoreMarkdownSourceEol(edited, refs.originalSourceRef.current)
  }

  if (
    editor &&
    edited !== refs.baseCanonicalRef.current &&
    reconciled === restoreMarkdownSourceEol(edited, refs.originalSourceRef.current)
  ) {
    const preserved = reconcileRichMarkdownBlockSource(
      editor,
      refs.originalSourceRef.current,
      edited,
      roundTrip
    )
    if (preserved !== null) {
      reconciled = preserved
    }
  }

  refs.originalSourceRef.current = reconciled
  // Reconciled output is semantically equal to edited, whose canonical form seeds the next reconciliation.
  refs.baseCanonicalRef.current = edited
  // External-change guards need the exact reconciled output, not its canonical representation.
  refs.lastCommittedMarkdownRef.current = reconciled
  return { markdown: reconciled, didSerialize: true }
}
