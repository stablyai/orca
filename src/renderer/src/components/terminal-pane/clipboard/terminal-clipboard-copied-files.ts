import { toast } from 'sonner'
import type { RefObject } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import { prepareOsFileDropPaths } from '@/lib/os-file-drop-preparation'
import type { PtyTransport } from '../pty-transport/pty-transport-types'
import type { TerminalClipboardCopiedFiles } from './terminal-clipboard-paste'
import {
  captureNativeTerminalFileDrop,
  type NativeTerminalFileDropArgs
} from '../input/file-drop/terminal-native-file-drop-destination'

/** Paste copied files like an OS drop on the pane: temp copies, SSH/runtime uploads, shell quoting. */
export function createTerminalClipboardCopiedFiles(
  args: Omit<NativeTerminalFileDropArgs, 'manager' | 'paneTransports' | 'paths'> & {
    managerRef: RefObject<PaneManager | null>
    paneTransportsRef: RefObject<Map<number, PtyTransport>>
  }
): TerminalClipboardCopiedFiles {
  const { managerRef, paneTransportsRef, ...destination } = args
  return {
    readPaths: window.api.ui.readClipboardFilePaths,
    hasImage: window.api.ui.clipboardHasImage,
    paste: async (paths) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const deliver = captureNativeTerminalFileDrop({
        ...destination,
        manager,
        paneTransports: paneTransportsRef.current
      })
      const prepared = await prepareOsFileDropPaths(paths, 'agent')
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await deliver(prepared.paths)
    }
  }
}
