/**
 * The snapshot half of an Office preview: render on the owning host, serve the result under an
 * inline grant, show it in the same fenced webview a workspace HTML document uses.
 *
 * The rendered bytes never enter the renderer. `office:openSnapshot` hands back a preview URL, so
 * this hook only ever holds a grant id — which is also the thing it has to release, on re-render
 * and on unmount, or a superseded snapshot stays live in main for the life of the process.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { OfficeDocKind } from '../../../../../shared/office-file-extensions'
import type { OfficeHostOwner } from '../../../../../shared/office-host-owner'
import type { OfficeDocumentLocation } from '@/lib/office-preview-plan'
import type { OfficeErrorCode } from '../../../../../shared/office-preview-contracts'
import { attachDocPreviewWebview } from './doc-preview-webview-attach'

export type OfficeSnapshotState =
  | { status: 'rendering' }
  | { status: 'ready'; kind: OfficeDocKind }
  | { status: 'failed'; code: OfficeErrorCode; detail?: string }

export type OfficeSnapshot = {
  state: OfficeSnapshotState
  /** Re-renders on the owning host and swaps the grant. */
  rerender: () => void
}

export function useOfficeSnapshot({
  previewId,
  document,
  owner,
  containerRef,
  enabled,
  onRendered
}: {
  previewId: string
  document: OfficeDocumentLocation | null
  owner: OfficeHostOwner | null
  containerRef: React.RefObject<HTMLDivElement | null>
  /** False while the live preview owns the pane, so the snapshot is not rendered behind it. */
  enabled: boolean
  onRendered?: () => void
}): OfficeSnapshot {
  const [state, setState] = useState<OfficeSnapshotState>({ status: 'rendering' })
  const [attempt, setAttempt] = useState(0)
  const onRenderedRef = useRef(onRendered)
  onRenderedRef.current = onRendered
  const ownerKey = owner ? JSON.stringify(owner) : null

  useEffect(() => {
    if (!enabled) {
      return
    }
    if (!owner || !document) {
      // An unresolved owner cannot pick a host, and rendering here would use the wrong machine's
      // officecli and fonts. See docs/reference/ssh-execution-boundary.md.
      setState({ status: 'failed', code: 'OFFICE_HOST_UNREACHABLE' })
      return
    }
    let disposed = false
    let grantId: string | null = null
    let detach: (() => void) | null = null
    setState({ status: 'rendering' })

    void window.api.office
      .openSnapshot({ owner, ...document, browserPageId: previewId })
      .then((result) => {
        if (disposed) {
          if (result.ok) {
            void window.api.office.releaseSnapshot(result.grantId)
          }
          return
        }
        if (!result.ok) {
          setState({
            status: 'failed',
            code: result.code,
            ...(result.detail ? { detail: result.detail } : {})
          })
          return
        }
        grantId = result.grantId
        const container = containerRef.current
        if (!container) {
          void window.api.office.releaseSnapshot(result.grantId)
          return
        }
        const attached = attachDocPreviewWebview({
          previewId,
          container,
          url: result.url,
          ariaLabel: translate(
            'auto.components.office.preview.snapshotAriaLabel',
            'Office document preview'
          ),
          onLoadStarted: () => {},
          onLoadStopped: () => {
            if (!disposed) {
              setState({ status: 'ready', kind: result.kind })
              onRenderedRef.current?.()
            }
          },
          onLoadFailed: (event) => {
            // -3 is an aborted load, which a re-render causes on purpose.
            if (!disposed && event.isMainFrame && event.errorCode !== -3) {
              setState({ status: 'failed', code: 'OFFICECLI_RENDER_FAILED' })
            }
          },
          onNavigated: () => {},
          // Why the document does not get to name the tab here: unlike an HTML document, a rendered
          // Office snapshot's <title> is officecli's, not the author's, and it would replace the
          // file name the reader opened with something like "document".
          onTitleUpdated: () => {}
        })
        detach = attached.detach
      })
      .catch(() => {
        if (!disposed) {
          setState({ status: 'failed', code: 'OFFICECLI_RENDER_FAILED' })
        }
      })

    return () => {
      disposed = true
      detach?.()
      if (grantId) {
        void window.api.office.releaseSnapshot(grantId)
      }
    }
  }, [attempt, containerRef, document, enabled, owner, ownerKey, previewId])

  const rerender = useCallback(() => setAttempt((count) => count + 1), [])
  return { state, rerender }
}
