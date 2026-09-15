import { useEffect } from 'react'
import { installOfficeLivePreviewSweep } from '@/lib/office-live-preview'

/**
 * App-level, because the surface that started a watch is gone by the time it matters.
 *
 * A live Office preview is a detached process on the owning host. Closing its browser tab
 * destroys the pane, so nothing inside the pane can be the thing that stops the process — the
 * sweep has to watch the store instead. Same shape as the `closed-editor-tab-*` sweeps.
 */
export function useOfficeLivePreviewSweep(): void {
  useEffect(() => installOfficeLivePreviewSweep(), [])
}
