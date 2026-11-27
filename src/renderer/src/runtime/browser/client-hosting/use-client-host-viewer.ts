import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { BrowserClientHostViewer } from '../../../../../shared/browser/client-hosting/browser-client-host-placement'

export type ClientHostViewerAnswer = BrowserClientHostViewer | 'unknown'

const RETRY_MS = 250
const MAX_ATTEMPTS = 40

/**
 * The viewer this page's client host decided at start (main). 'unknown' until the page has live
 * client placement and main has an answer: staged and restored tabs mount before their host starts.
 * A new host generation (reconnect) asks again.
 */
export function useClientHostViewer(
  environmentId: string,
  browserPageId: string,
  enabled = true
): ClientHostViewerAnswer {
  const hostGeneration = useAppStore((s) => {
    const handle = s.remoteBrowserPageHandlesByPageId[browserPageId]
    return handle?.environmentId === environmentId && handle.placement?.kind === 'client'
      ? handle.placement.browserHostGeneration
      : null
  })
  const key = enabled && hostGeneration !== null ? `${environmentId}\0${hostGeneration}` : null
  const [answer, setAnswer] = useState<{ key: string; viewer: BrowserClientHostViewer } | null>(
    null
  )
  useEffect(() => {
    if (key === null) {
      return
    }
    return readClientHostViewer(environmentId, (viewer) => setAnswer({ key, viewer }))
  }, [environmentId, key])
  return answer !== null && answer.key === key ? answer.viewer : 'unknown'
}

// Main records the viewer as the host starts; a placement can land just before that, so retry a null.
function readClientHostViewer(
  environmentId: string,
  onAnswer: (viewer: BrowserClientHostViewer) => void
): () => void {
  const read = window.api.runtimeEnvironments.browserClientHostViewer
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const ask = (attempt: number): void => {
    if (!read) {
      return
    }
    void read(environmentId)
      .catch(() => null)
      .then((viewer) => {
        if (cancelled) {
          return
        }
        if (viewer) {
          onAnswer(viewer)
        } else if (attempt < MAX_ATTEMPTS) {
          timer = setTimeout(() => ask(attempt + 1), RETRY_MS)
        }
      })
  }
  ask(1)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}
