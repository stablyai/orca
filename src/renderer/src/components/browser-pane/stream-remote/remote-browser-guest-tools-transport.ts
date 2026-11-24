import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  BrowserGrabResult,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverResult,
  BrowserSetGrabModeResult
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserGuestToolsTransport } from '../annotate/browser-guest-tools-transport'
import type { RemoteBrowserInputQueue } from './remote-browser-input-queue'

const GRAB_RPC_TIMEOUT_MS = 15_000

/**
 * Runs the guest tools on the runtime that renders a streamed page; page IDs there are the
 * runtime's own. Requests that read or change pointer state take their turn in the page's input
 * queue, so they see every move and click the user made before them.
 */
export function createRemoteBrowserGuestToolsTransport({
  target,
  worktree,
  remotePage,
  inputQueue
}: {
  target: () => RuntimeClientTarget | null
  worktree: string
  remotePage: () => string | null
  inputQueue: RemoteBrowserInputQueue
}): BrowserGuestToolsTransport {
  // Each wait's request, so a request-scoped cancel ends only that request's wait.
  const awaitingSelections = new Map<AbortController, string | undefined>()
  // Enables still queued behind earlier input: the host has no record of them yet, so a cancel
  // retires them here and they never send.
  const unsentEnables = new Set<{ requestId?: string; retired: boolean }>()

  const call = async <T>(
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; page?: string | null } = {}
  ): Promise<T | null> => {
    const runtime = target()
    const page = 'page' in options ? options.page : remotePage()
    if (!runtime || !page) {
      return null
    }
    return callRuntimeRpc<T>(
      runtime,
      method,
      { ...params, worktree, page },
      {
        // The host's own grab timeout ends a selection; an abortable call is not cut off at 15s.
        ...(options.signal ? { signal: options.signal } : { timeoutMs: GRAB_RPC_TIMEOUT_MS }),
        suppressFeatureInteraction: true
      }
    )
  }

  const inInputOrder = <T>(run: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      void inputQueue.enqueue(() => run().then(resolve, reject))
    })

  return {
    setGrabMode: ({ enabled, requestId }) => {
      const page = remotePage()
      const unsent = enabled ? { requestId, retired: false } : null
      if (unsent) {
        unsentEnables.add(unsent)
      }
      return inInputOrder(async (): Promise<BrowserSetGrabModeResult> => {
        if (unsent) {
          unsentEnables.delete(unsent)
          if (unsent.retired) {
            return { ok: false, reason: 'not-ready' }
          }
        }
        try {
          return (
            (await call<BrowserSetGrabModeResult>(
              'browser.grab.setMode',
              { enabled, requestId },
              { page }
            )) ?? {
              ok: false,
              reason: 'not-ready'
            }
          )
        } catch {
          return enabled ? { ok: false, reason: 'injection-failed' } : { ok: true }
        }
      })
    },
    // Not queued: it waits for a click, and the click must be able to reach the page meanwhile.
    awaitGrabSelection: async ({ opId, requestId }): Promise<BrowserGrabResult> => {
      const controller = new AbortController()
      awaitingSelections.set(controller, requestId)
      try {
        return (
          (await call<BrowserGrabResult>(
            'browser.grab.await',
            { opId, requestId },
            { signal: controller.signal }
          )) ?? { opId, kind: 'error', reason: 'Guest not ready' }
        )
      } catch (error) {
        return controller.signal.aborted
          ? { opId, kind: 'cancelled', reason: 'user' }
          : {
              opId,
              kind: 'error',
              reason: error instanceof Error ? error.message : 'Selection failed'
            }
      } finally {
        awaitingSelections.delete(controller)
      }
    },
    cancelGrab: async ({ requestId }): Promise<boolean> => {
      const page = remotePage()
      // A rearm during the round trip starts a new wait that this cancel must not end, and a
      // retired request's cancel must not end the wait of the request that replaced it.
      const cancelledSelections = [...awaitingSelections]
        .filter(([, waitRequestId]) => requestId === undefined || waitRequestId === requestId)
        .map(([controller]) => controller)
      let retiredUnsent = false
      for (const unsent of unsentEnables) {
        if (requestId === undefined || unsent.requestId === requestId) {
          unsent.retired = true
          retiredUnsent = true
        }
      }
      // Ask the host to settle the pick first; aborting alone would leave its overlay armed until the call closes.
      // Not queued: an enable ahead of it in the queue waits for its page, and the host must see this
      // cancel meanwhile so the enable never arms.
      const cancelled = await call<{ cancelled: boolean }>(
        'browser.grab.cancel',
        { requestId },
        { page }
      )
        .then((result) => result?.cancelled ?? false)
        .catch(() => false)
      for (const controller of cancelledSelections) {
        controller.abort()
      }
      return cancelled || retiredUnsent
    },
    captureSelectionScreenshot: ({ rect, selectionId }) => {
      const page = remotePage()
      return inInputOrder(async (): Promise<BrowserCaptureSelectionScreenshotResult> => {
        try {
          return (
            (await call<BrowserCaptureSelectionScreenshotResult>(
              'browser.grab.captureSelection',
              { rect, selectionId },
              { page }
            )) ?? { ok: false, reason: 'Guest not ready' }
          )
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : 'Capture failed' }
        }
      })
    },
    // C/S read the element under the pointer, so they wait for the moves made before the key.
    extractHoverPayload: () => {
      const page = remotePage()
      return inInputOrder(async (): Promise<BrowserExtractHoverResult> => {
        try {
          return (
            (await call<BrowserExtractHoverResult>('browser.grab.extractHover', {}, { page })) ?? {
              ok: false,
              reason: 'Guest not ready'
            }
          )
        } catch (error) {
          return { ok: false, reason: error instanceof Error ? error.message : 'Hover read failed' }
        }
      })
    },
    setAnnotationViewportBridge: async ({ enabled, emitViewport, markers, selectionId, token }) => {
      const result = await call<{ applied: boolean }>('browser.grab.viewportBridge', {
        enabled,
        emitViewport,
        markers,
        ...(selectionId === undefined ? {} : { selectionId }),
        token
      })
      return result?.applied ?? false
    },
    grabPickedElementPresent: async ({ selectionId, interactive }) => {
      try {
        return await call<boolean | null>('browser.grab.pickedPresent', {
          selectionId,
          interactive
        })
      } catch {
        return null
      }
    },
    // The host does not install a renderer-directed bare-key policy for a streamed viewer.
    onGrabPolicyRetired: () => () => {},
    // The renderer sees every streamed key before the host, so no guest forwards chords back.
    onGrabModeToggle: () => () => {},
    onGrabActionShortcut: () => () => {}
  }
}
