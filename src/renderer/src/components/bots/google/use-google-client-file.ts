import { useState } from 'react'
import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { GOOGLE_CLIENT_FILE_MAX_BYTES } from '../../../../../shared/google/google-client-config'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewState
} from '../../native-chat/pane/ownership/native-chat-view-memory'

/** Drag handlers for an element that takes a dropped Google app file. */
export type GoogleClientFileDropTarget = {
  onDragOver: (event: React.DragEvent) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
  'data-dragging': boolean
}

// React bubbles drag events out of portals (the setup dialog); only drags over the target's own DOM count.
function ownsDrag(event: React.DragEvent): boolean {
  return (
    !event.defaultPrevented &&
    event.target instanceof Node &&
    event.currentTarget.contains(event.target)
  )
}

/** Reads a Google app file the person picks (the picker opens at Downloads), drops or types in. */
export function useGoogleClientFile(
  onFile: (text: string) => Promise<void>,
  options?: {
    /** Asked before the picker opens; true when the key's host imported one itself. */
    tryHost?: () => Promise<boolean>
    /** A card in a chat: its import stays busy through the chat's release. */
    memoryKey?: string
  }
): {
  busy: boolean
  error: string | null
  pick: () => Promise<void>
  /** The picker on this computer, without asking the key's host first. */
  pickHere: () => Promise<void>
  submit: (text: string) => Promise<void>
  dropTarget: GoogleClientFileDropTarget
} {
  const t = useTranslate()
  // Kept with the chat tab: a card released mid-import returns still importing, or saying why it failed.
  const [busy, setBusy] = useNativeChatViewState(
    options?.memoryKey === undefined ? undefined : `google-client-file:${options.memoryKey}`,
    false
  )
  const [error, setError] = useNativeChatViewState<string | null>(
    options?.memoryKey === undefined ? undefined : `google-client-file-error:${options.memoryKey}`,
    null,
    KEPT_PROMPT_VIEWS
  )
  const [dragging, setDragging] = useState(false)

  const take = async (read: () => Promise<string | null>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const text = await read()
      if (text !== null) {
        await onFile(text)
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  const pickFrom = (askHost: boolean): Promise<void> =>
    take(async () => {
      if (askHost && (await options?.tryHost?.())) {
        return null
      }
      const picked = await window.api.googleSetup.pickClientFile()
      if (picked && !picked.ok) {
        throw new Error(picked.message)
      }
      return picked?.text ?? null
    })

  const dropTarget: GoogleClientFileDropTarget = {
    onDragOver: (event) => {
      if (!ownsDrag(event)) {
        return
      }
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event) => {
      // Moving onto a child also fires dragleave; only leaving the target ends the highlight.
      const next = event.relatedTarget
      if (!(next instanceof Node && event.currentTarget.contains(next))) {
        setDragging(false)
      }
    },
    onDrop: (event) => {
      if (!ownsDrag(event)) {
        return
      }
      event.preventDefault()
      setDragging(false)
      const file = event.dataTransfer.files[0]
      if (!file) {
        return
      }
      void take(async () => {
        if (file.size > GOOGLE_CLIENT_FILE_MAX_BYTES) {
          throw new Error(
            t('bots.google.file.tooLarge', 'This file is too large to be a Google app file.')
          )
        }
        return file.text()
      })
    },
    'data-dragging': dragging
  }

  return {
    busy,
    error,
    pick: () => pickFrom(true),
    pickHere: () => pickFrom(false),
    submit: (text) => take(async () => text),
    dropTarget
  }
}
