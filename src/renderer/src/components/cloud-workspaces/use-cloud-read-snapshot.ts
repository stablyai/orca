import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudReadViewState } from '../orca-cloud/read-snapshot/CloudReadSnapshotView'
import { describeError } from './cloud-workspace-errors'

// Machine error code (never shown): the bridge call itself failed; describeError() has the copy.
const IPC_FAILED_CODE = 'unavailable'

/**
 * A sleeping workspace's read-only copy, read once per open (and on Try again). Reads only while
 * `id` is set; an answer for a workspace that is no longer asked for is dropped.
 */
export function useCloudReadSnapshot(id: string | null): {
  state: CloudReadViewState
  retry: () => void
  retrying: boolean
} {
  const t = useTranslate()
  const [state, setState] = useState<CloudReadViewState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const asked = useRef(id)
  asked.current = id

  useEffect(() => {
    if (!id) {
      return
    }
    let live = true
    void window.api.cloudWorkspaces
      .readSnapshot(id)
      .catch((): { ok: false; error: string; reason?: string } => ({
        ok: false,
        error: IPC_FAILED_CODE
      }))
      .then((result) => {
        if (!live || asked.current !== id) {
          return
        }
        setRetrying(false)
        if (!result.ok) {
          setState({
            kind: 'error',
            message:
              result.error === 'snapshot_unreadable'
                ? t(
                    'components.orcaCloud.read.unreadable',
                    "Couldn't open the saved copy on this computer. Your files are safe."
                  )
                : describeError(result.error, result.reason, t)
          })
          return
        }
        const value = result.value
        setState(
          value.state === 'ready'
            ? { kind: 'ready', snapshot: value.snapshot }
            : value.state === 'unavailable'
              ? { kind: 'unavailable', message: value.message }
              : value.state === 'unverified'
                ? { kind: value.reason === 'signer_changed' ? 'signer_changed' : 'unverified' }
                : { kind: value.state }
        )
      })
    return () => {
      live = false
    }
  }, [id, attempt, t])

  // A different workspace starts from the skeleton, never the previous one's copy.
  const [shownFor, setShownFor] = useState(id)
  if (shownFor !== id) {
    setShownFor(id)
    setState({ kind: 'loading' })
    setRetrying(false)
  }

  const retry = useCallback(() => {
    setRetrying(true)
    setAttempt((value) => value + 1)
  }, [])

  return { state, retry, retrying }
}
