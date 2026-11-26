import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type {
  NgitMutationResult,
  NgitViewer,
  NgitWorkItem,
  NgitWorkItemDetails
} from '../../../../../shared/ngit/ngit-work-item-types'
import { ngitApiFor } from '@/runtime/repository-ngit/ngit-owner-api'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { translate } from '@/i18n/i18n'

type NgitWrite = (api: ReturnType<typeof ngitApiFor>) => Promise<NgitMutationResult>

async function publishWithToast(pending: Promise<NgitMutationResult>): Promise<boolean> {
  try {
    const result = await pending
    if (!result.ok) {
      toast.error(result.error)
    }
    return result.ok
  } catch (reason) {
    toast.error(
      translate('components.taskPage.ngit.publishFailed', 'ngit could not publish: {{error}}', {
        error: readIpcErrorDetail(reason) ?? String(reason)
      })
    )
    return false
  }
}

/** One open item's relay details, the signing identity, and the writes made against it. */
export function useNgitItemDetails(item: NgitWorkItem, repo: Repo, onChanged: () => void) {
  const [details, setDetails] = useState<NgitWorkItemDetails | null>(null)
  const [viewer, setViewer] = useState<NgitViewer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [writing, setWriting] = useState(false)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const lastNonceRef = useRef(0)
  const repoRef = useRef(repo)
  useEffect(() => {
    repoRef.current = repo
  }, [repo])

  useEffect(() => {
    const force = refreshNonce !== lastNonceRef.current
    lastNonceRef.current = refreshNonce
    let stale = false
    setLoading(true)
    setError(null)
    ngitApiFor(repoRef.current)
      .workItemDetails(item.eventId, force)
      .then((next) => {
        if (!stale) {
          setDetails(next)
        }
      })
      .catch((reason) => {
        if (!stale) {
          setError(readIpcErrorDetail(reason) ?? String(reason))
        }
      })
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [item.eventId, refreshNonce])

  useEffect(() => {
    let stale = false
    ngitApiFor(repoRef.current)
      .viewer()
      .then((next) => {
        if (!stale) {
          setViewer(next)
        }
      })
      // Unknown identity leaves the actions enabled; the write itself reports the reason.
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [repo.id])

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), [])

  const publish = useCallback(
    async (write: NgitWrite) => {
      setWriting(true)
      const published = await publishWithToast(write(ngitApiFor(repoRef.current)))
      setWriting(false)
      if (published) {
        refresh()
        onChanged()
      }
      return published
    },
    [onChanged, refresh]
  )

  return { details, viewer, error, loading, writing, refresh, publish }
}
