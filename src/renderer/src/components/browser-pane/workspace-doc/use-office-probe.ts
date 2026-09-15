/**
 * Whether the owning host has `officecli`, asked lazily.
 *
 * Only consulted once a render has already reported the binary missing: probing up front would
 * spend a host round-trip on every preview to learn something the render itself reports. What the
 * probe adds is the part the render cannot — the host's own platform, which decides which install
 * command the reader is shown, and whether this build has `watch` at all.
 */
import { useCallback, useEffect, useState } from 'react'
import type { OfficeHostOwner } from '../../../../../shared/office-host-owner'
import type { OfficeDocumentLocation } from '@/lib/office-preview-plan'
import type { OfficeHostPlatform } from '../../../../../shared/office-preview-contracts'

export type OfficeProbe = {
  platform: OfficeHostPlatform
  supportsWatch: boolean
  installed: boolean
  /**
   * False until the host answers. Callers must gate on it before reading `installed` or
   * `supportsWatch`: the defaults are the *absent* answer, so treating them as fact would disable
   * the Live toggle for the first frames of every preview and blame a binary that is right there.
   */
  answered: boolean
  /** True while a reader-driven retry is in flight, so the Retry control can say so. */
  refreshing: boolean
  refresh: () => void
}

export function useOfficeProbe({
  owner,
  document,
  enabled
}: {
  owner: OfficeHostOwner | null
  document: OfficeDocumentLocation | null
  enabled: boolean
}): OfficeProbe {
  const [platform, setPlatform] = useState<OfficeHostPlatform>('unknown')
  const [supportsWatch, setSupportsWatch] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [answered, setAnswered] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const ownerKey = owner ? JSON.stringify(owner) : null

  useEffect(() => {
    if (!enabled || !owner || !document) {
      return
    }
    let disposed = false
    setAnswered(false)
    setRefreshing(attempt > 0)
    void window.api.office
      .probe({
        owner,
        workspaceRoot: document.workspaceRoot,
        ...(attempt > 0 ? { refresh: true } : {})
      })
      .then((outcome) => {
        if (disposed) {
          return
        }
        setRefreshing(false)
        if (!outcome.ok) {
          return
        }
        setPlatform(outcome.platform)
        setSupportsWatch(outcome.supportsWatch)
        setInstalled(outcome.installed)
        setAnswered(true)
      })
      .catch(() => {
        if (!disposed) {
          setRefreshing(false)
        }
      })
    return () => {
      disposed = true
    }
  }, [attempt, document, enabled, owner, ownerKey])

  const refresh = useCallback(() => setAttempt((count) => count + 1), [])
  return { platform, supportsWatch, installed, answered, refreshing, refresh }
}
