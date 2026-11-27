import { useMemo, type RefObject } from 'react'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  createOsFileDropSequence,
  useOsFileDropOwner
} from '@/lib/files/drop/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/files/drop/native-file-drop-rejection-message'
import { terminalFileDropErrorMessage } from '@/components/terminal-pane/input/file-drop/terminal-native-file-drop-error'
import type { RemoteBrowserRuntimeTarget } from './remote-browser-page-input-model'
import { useRuntimeEnvironmentCapability } from '@/runtime/rpc/compatibility/use-runtime-environment-capability'
import { BROWSER_DROP_FILES_RUNTIME_CAPABILITY } from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import { stageRemoteBrowserFilesOnHost } from './remote-browser-host-file-staging'

type RemoteBrowserFileDropPoint = {
  target: RemoteBrowserRuntimeTarget
  pageId: string
  pageUrl: string
  x: number
  y: number
}

/** Files dragged from this computer onto a streamed page: upload them to its host, then drop them where they were let go. */
export function useRemoteBrowserPageFileDrop({
  remoteViewportRef,
  lifecycle,
  runtimeTarget,
  runtimeWorktree,
  getPageUrl,
  getRemoteImagePoint
}: {
  remoteViewportRef: RefObject<HTMLElement | null>
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  runtimeWorktree: string
  getPageUrl: () => string
  getRemoteImagePoint: (event: {
    clientX: number
    clientY: number
  }) => { x: number; y: number } | null
}): (root: HTMLElement | null) => void {
  const sequence = useMemo(() => createOsFileDropSequence(), [])
  const hostTakesFiles = useRuntimeEnvironmentCapability(
    runtimeTarget()?.environmentId,
    BROWSER_DROP_FILES_RUNTIME_CAPABILITY
  )
  return useOsFileDropOwner<RemoteBrowserFileDropPoint | null>(remoteViewportRef, {
    consumer: 'agent',
    sequence,
    // Older hosts can't take files; the drop is refused as it was.
    canAccept: hostTakesFiles,
    captureDestination: (event) => {
      const target = runtimeTarget()
      const pageId = lifecycle.tokens.remotePage
      const point = getRemoteImagePoint(event)
      return target && pageId && point ? { target, pageId, pageUrl: getPageUrl(), ...point } : null
    },
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      if (!destination || prepared.paths.length === 0) {
        return
      }
      const { target, pageId, pageUrl, x, y } = destination
      const page = { target, worktree: runtimeWorktree, pageId }
      const files = await stageRemoteBrowserFilesOnHost(page, prepared.paths)
      if (files.length === 0) {
        return
      }
      await callRuntimeRpc(
        target,
        'browser.dropFiles',
        // Uploading takes time; files for this document never land on the next one.
        { worktree: runtimeWorktree, page: pageId, x, y, files, expectUrl: pageUrl },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      ).catch((error: unknown) => toast.error(terminalFileDropErrorMessage(error, 'drop')))
    }
  })
}
