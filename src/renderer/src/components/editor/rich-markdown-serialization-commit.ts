import type { MutableRefObject } from 'react'
import type { Editor } from '@tiptap/react'
import {
  reconcileSerializedMarkdown,
  restoreMarkdownSourceEol
} from './rich-markdown-source-reconcile'

export type RichMarkdownReconcileRefs = {
  /** Current on-disk source bytes; updated to the reconciled output each commit. */
  originalSourceRef: MutableRefObject<string>
  /** Canonical serialization of `originalSourceRef` (getMarkdown of the unedited doc). */
  baseCanonicalRef: MutableRefObject<string>
  /** Exact bytes last handed to disk; gates the external-change reload. */
  lastCommittedMarkdownRef: MutableRefObject<string>
}

export type RichMarkdownSerializationCommit = {
  /** Bytes to persist to disk (reconciled, or last committed on a torn-down editor). */
  markdown: string
  /** False when the editor was torn down before serializing (refs left untouched). */
  didSerialize: boolean
}

/**
 * Single place where reconciliation and ref updates happen for every disk-bound
 * serialize site. Computes edited=getMarkdown(), reconciles toward the original
 * source style, and advances the refs for the next incremental edit.
 */
export function commitRichMarkdownSerialization(
  editor: Editor | null,
  refs: RichMarkdownReconcileRefs,
  roundTrip: (markdown: string) => string | null
): RichMarkdownSerializationCommit {
  let edited: string | undefined
  try {
    edited = editor?.getMarkdown()
  } catch {
    // Why: the editor can be destroyed between scheduling and serializing; a
    // save/restart flush must never crash here.
    edited = undefined
  }
  if (edited === undefined) {
    // Torn-down fallback: reuse the already-reconciled bytes without patching.
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

  refs.originalSourceRef.current = reconciled
  // Why: reconciled ≡ edited semantically, so its canonical form is `edited`
  // (also correct in every fallback branch, which returns `edited` verbatim).
  refs.baseCanonicalRef.current = edited
  // Why: the external-change guard short-circuits on lastCommittedMarkdownRef, so
  // it must hold the exact reconciled bytes that reach disk, not the canonical form.
  refs.lastCommittedMarkdownRef.current = reconciled
  return { markdown: reconciled, didSerialize: true }
}
