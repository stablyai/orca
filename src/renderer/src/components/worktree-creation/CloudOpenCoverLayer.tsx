import React, { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useNow } from '@/hooks/use-now'
import {
  CLOUD_OPEN_COVER_MAX_MS,
  releaseCloudOpenCover,
  useCloudOpenCover,
  workspaceHasAttachedPty
} from '@/lib/orca-cloud/cloud-open-cover-store'
import type CloudOpenCoverBodyComponent from './CloudOpenCoverBody'

// The body pulls in the build sheet, which the shell must not load at boot. The creation panel
// preloads it, so it is ready (no Suspense frame) by the time a create hands over.
let Body: typeof CloudOpenCoverBodyComponent | null = null
let loading: Promise<void> | null = null
const bodyListeners = new Set<() => void>()

export function preloadCloudOpenCover(): Promise<void> {
  loading ??= import('./CloudOpenCoverBody')
    .then((module) => {
      Body = module.default
      for (const listener of bodyListeners) {
        listener()
      }
    })
    .catch(() => {
      loading = null
    })
  return loading
}

function useBody(): typeof CloudOpenCoverBodyComponent | null {
  return useSyncExternalStore(
    (listener) => {
      bodyListeners.add(listener)
      return () => bodyListeners.delete(listener)
    },
    () => Body
  )
}

/**
 * Keeps the Orca Cloud start screen over a just-created workspace until its terminal's PTY is
 * attached (JA-12), so "Open workspace" goes straight to a live prompt with no blank pane between.
 */
export function CloudOpenCoverLayer({
  reserveCollapsedSidebarHeaderSpace
}: {
  reserveCollapsedSidebarHeaderSpace: boolean
}): React.JSX.Element | null {
  const worktreeId = useAppStore((s) => (s.activeView === 'terminal' ? s.activeWorktreeId : null))
  const cover = useCloudOpenCover(worktreeId)
  const attached = useAppStore((s) =>
    cover ? workspaceHasAttachedPty(s, cover.worktreeId) : false
  )
  const BodyComponent = useBody()
  const now = useNow(1_000, cover !== null)
  useEffect(() => {
    if (!cover) {
      return
    }
    if (attached) {
      releaseCloudOpenCover(cover.worktreeId)
      return
    }
    void preloadCloudOpenCover()
    const left = Math.max(0, cover.heldAt + CLOUD_OPEN_COVER_MAX_MS - Date.now())
    const timer = window.setTimeout(() => releaseCloudOpenCover(cover.worktreeId), left)
    return () => window.clearTimeout(timer)
  }, [attached, cover])
  if (!cover || attached || !BodyComponent) {
    return null
  }
  // The body is a module-level component loaded once, not one made during render.
  return React.createElement(BodyComponent, {
    cover,
    now: Math.max(now, cover.heldAt),
    reserveCollapsedSidebarHeaderSpace
  })
}
