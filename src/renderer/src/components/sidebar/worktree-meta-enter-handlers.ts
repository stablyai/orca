import type React from 'react'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'

type EnterGestureOwnership = { ownsKeyDown: (event: React.KeyboardEvent) => boolean }

/**
 * Enter handling for the worktree-meta dialog, split out of `WorktreeMetaDialog.tsx` because the
 * two fields need different IME tiers and the dialog is at its `max-lines` ceiling.
 *
 * The comment textarea takes free CJK prose, so it needs full gesture ownership: the plain-Enter
 * path is reachable by the IME confirm's unmarked redispatch, which the oracle alone cannot see.
 * The issue/PR fields take digits and URLs, so the oracle tier is enough there.
 */
export function handleWorktreeMetaCommentKeyDown(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  commentEnterGesture: EnterGestureOwnership,
  save: () => void
): void {
  // Why: the carry token owns modifier-carrying Enters, so the chord resolves first — otherwise a
  // modifier held through the confirm redispatch loses the user's deliberate save.
  if (isScreenSubmitShortcut(e)) {
    if (isImeOwnedKeyboardEvent(e)) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    save()
    return
  }
  if (commentEnterGesture.ownsKeyDown(e)) {
    return
  }
  const isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
  if (isPlainEnter) {
    e.preventDefault()
    e.stopPropagation()
    save()
  }
}
