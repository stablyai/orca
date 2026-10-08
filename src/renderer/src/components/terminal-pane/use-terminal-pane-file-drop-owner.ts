import { useRef, useState, type RefObject } from 'react'
import { toast } from 'sonner'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { isElementDisplayNone } from '@/lib/pane-manager/pane-display-visibility'
import {
  createOsFileDropSequence,
  useOsFileDropOwner,
  type OsFileDropSequence
} from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/hooks/useGlobalFileDrop'
import { makePaneKey, type PaneKey } from '../../../../shared/stable-pane-id'
import type { PtyTransport } from './pty-transport'
import { captureNativeTerminalFileDrop } from './terminal-native-file-drop-destination'

export type TerminalPaneFileDropOwnerArgs = {
  pane: ManagedPane
  tabId: string
  worktreeId: string
  cwd: string | undefined
  managerRef: RefObject<PaneManager | null>
  paneTransportsRef: RefObject<Map<number, PtyTransport>>
}

// Sibling title/body roots share ordering for exactly this mounted pane.
const paneSequences = new WeakMap<HTMLElement, { paneKey: PaneKey; sequence: OsFileDropSequence }>()

function sequenceForPane(pane: ManagedPane, paneKey: PaneKey): OsFileDropSequence {
  const existing = paneSequences.get(pane.container)
  if (existing?.paneKey === paneKey) {
    return existing.sequence
  }
  const sequence = createOsFileDropSequence()
  paneSequences.set(pane.container, { paneKey, sequence })
  return sequence
}

function paneIsCurrent(manager: PaneManager | null, pane: ManagedPane): boolean {
  return Boolean(
    manager
      ?.getPanes()
      .some(
        (current) =>
          current.id === pane.id &&
          current.leafId === pane.leafId &&
          current.container === pane.container
      )
  )
}

export function useTerminalPaneFileDropOwner(
  args: TerminalPaneFileDropOwnerArgs
): (root: HTMLElement | null) => void {
  const { pane, tabId, managerRef, paneTransportsRef } = args
  const rootRef = useRef<HTMLElement | null>(null)
  const paneKey = makePaneKey(tabId, pane.leafId)
  const [sequence] = useState(() => sequenceForPane(pane, paneKey))
  return useOsFileDropOwner(rootRef, {
    consumer: 'agent',
    sequence,
    canAccept: () =>
      Boolean(
        rootRef.current?.isConnected &&
        !rootRef.current.closest('[inert]') &&
        !isElementDisplayNone(rootRef.current) &&
        paneIsCurrent(managerRef.current, pane) &&
        paneTransportsRef.current.get(pane.id)?.isConnected()
      ),
    captureDestination: () => {
      const manager = managerRef.current
      const paneTransports = paneTransportsRef.current
      if (!manager) {
        return undefined
      }
      const deliver = captureNativeTerminalFileDrop({ ...args, manager, paneTransports })
      return async (paths: string[]) => {
        if (
          managerRef.current !== manager ||
          paneTransportsRef.current !== paneTransports ||
          makePaneKey(tabId, pane.leafId) !== paneKey ||
          !paneIsCurrent(manager, pane)
        ) {
          return
        }
        await deliver(paths)
      }
    },
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await destination?.(prepared.paths)
    }
  })
}
