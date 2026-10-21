import { useLayoutEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  createOsFileDropSequence,
  useOsFileDropOwner,
  type OsFileDropSequence
} from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import {
  captureEditorFileDropOpen,
  editorGroupStillExists,
  type EditorFileDropDestination
} from './editor-dropped-file-open'

type GroupSequenceEntry = { sequence: OsFileDropSequence; owners: number }

// The tab strip and editor area are sibling roots of one group and render in different trees.
const groupSequences = new Map<string, GroupSequenceEntry>()

function groupSequenceEntry(key: string): GroupSequenceEntry {
  const existing = groupSequences.get(key)
  if (existing) {
    return existing
  }
  const entry = { sequence: createOsFileDropSequence(), owners: 0 }
  groupSequences.set(key, entry)
  return entry
}

function useEditorGroupFileDropSequence(key: string): OsFileDropSequence {
  useLayoutEffect(() => {
    const entry = groupSequenceEntry(key)
    entry.owners += 1
    return () => {
      entry.owners -= 1
      // Why: wait for queued drops, so a root remounting in the same commit keeps their order.
      void entry.sequence.deliveryTail.then(() => {
        if (entry.owners === 0 && groupSequences.get(key) === entry) {
          groupSequences.delete(key)
        }
      })
    }
  }, [key])
  // Resolved when a drop queues, never during render.
  return useMemo(
    () => ({
      get deliveryTail() {
        return groupSequenceEntry(key).sequence.deliveryTail
      },
      set deliveryTail(tail: Promise<void>) {
        groupSequenceEntry(key).sequence.deliveryTail = tail
      }
    }),
    [key]
  )
}

/** Opens OS files dropped on this group's tab strip or editor area in that group's worktree. */
export function useEditorGroupFileDropOwner({
  worktreeId,
  groupId
}: EditorFileDropDestination): (root: HTMLElement | null) => void {
  const rootRef = useRef<HTMLElement | null>(null)
  const sequence = useEditorGroupFileDropSequence(`${worktreeId}\0${groupId ?? ''}`)
  return useOsFileDropOwner(rootRef, {
    consumer: 'main-reader',
    sequence,
    captureDestination: () => captureEditorFileDropOpen({ worktreeId, groupId }),
    // Why: switching to a terminal tab unmounts the editor area; the open step checks the group.
    isDestinationLive: () => editorGroupStillExists({ worktreeId, groupId }),
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await destination?.(prepared.paths)
    }
  })
}
