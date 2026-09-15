import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { decodeBrowserScreencastFrame } from '../../../../shared/browser-screencast-protocol'
import type { WorkspaceViewBridge } from '../../../../shared/workspace-view-bridge'

async function openBrowserWatch(
  pageId: string,
  worktreeId: string,
  environmentId: string | undefined,
  callbacks: Parameters<WorkspaceViewBridge['subscribeBrowser']>[1]
): Promise<{ unsubscribe: () => void }> {
  const params = { page: pageId, worktree: `id:${worktreeId}`, format: 'jpeg' }
  if (environmentId) {
    return window.api.runtimeEnvironments.subscribe(
      {
        selector: environmentId,
        method: 'browser.screencast',
        params,
        expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(environmentId)
      },
      callbacks
    )
  }
  const status = await callRuntimeRpc<{ runtimeId: string }>({ kind: 'local' }, 'status.get')
  const stream = await window.orcaWorkspaceViews?.subscribeBrowser(
    { runtimeId: status.runtimeId, params },
    callbacks
  )
  if (!stream) {
    throw new Error('Browser session unavailable')
  }
  return stream
}

export function WorkspaceBrowserWatcher({
  pageId,
  worktreeId,
  environmentId
}: {
  pageId: string
  worktreeId: string
  environmentId?: string
}) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    let url: string | null = null
    let stream: { unsubscribe: () => void } | null = null
    const callbacks = {
      onResponse: () => {},
      onBinary: (bytes: Uint8Array<ArrayBufferLike>): void => {
        if (disposed) {
          return
        }
        const frame = decodeBrowserScreencastFrame(bytes)
        if (!frame) {
          return
        }
        const next = URL.createObjectURL(
          new Blob([new Uint8Array(frame.image)], { type: `image/${frame.format}` })
        )
        if (url) {
          URL.revokeObjectURL(url)
        }
        url = next
        setFrameUrl(next)
      },
      onError: (reason: { message: string }): void => {
        if (!disposed) {
          setError(reason.message)
        }
      }
    }
    void openBrowserWatch(pageId, worktreeId, environmentId, callbacks)
      .then((subscription) => {
        stream = subscription
        if (disposed) {
          stream.unsubscribe()
        }
      })
      .catch((reason) => {
        if (!disposed) {
          setError(String(reason))
        }
      })
    return () => {
      disposed = true
      stream?.unsubscribe()
      if (url) {
        URL.revokeObjectURL(url)
      }
    }
  }, [pageId, worktreeId, environmentId])
  return frameUrl ? (
    <img
      src={frameUrl}
      alt="Shared browser view"
      draggable={false}
      className="h-full w-full object-contain object-top pointer-events-none"
    />
  ) : (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {error ?? 'Connecting to browser…'}
    </p>
  )
}
