import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { fetchActionsArtifacts } from '@/store/github/actions-artifact-requests'
import { actionsRepoProbeKey } from '@/components/right-sidebar/actions-repositories'
import type { ActionsRepositoryOption } from '@/components/right-sidebar/use-actions-repositories'
import type { ActionsPage } from '../../../../../../shared/github/actions-types'
import type { ActionsArtifact } from '../../../../../../shared/github/actions-artifact-types'
import { downloadActionsArtifact } from './download-actions-artifact'
/** Fence paginated artifact reads and coordinate one cancelable save without treating intentional cancel as an error. */
export function useActionsArtifacts(option: ActionsRepositoryOption, runId: number) {
  const [state, setState] = useState<{
    data: ActionsPage<ActionsArtifact> | null
    loading: boolean
    error: string | null
  }>({ data: null, loading: true, error: null })
  const [download, setDownload] = useState<{
    id: number | null
    percent: number
    error: string | null
    saved: string | null
  }>({ id: null, percent: 0, error: null, saved: null })
  const current = useRef(state)
  current.current = state
  const generation = useRef(0)
  const alive = useRef(true)
  const canceled = useRef(false)
  const read = useCallback(
    async (append = false) => {
      const prior = current.current.data
      if (append && (current.current.loading || !prior?.hasNextPage)) {
        return
      }
      const request = ++generation.current
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const data = await fetchActionsArtifacts(
          useAppStore.getState(),
          {
            repoId: option.repo.id,
            repoPath: option.repo.path,
            ownerKey: actionsRepoProbeKey(option.repo)
          },
          { repository: option.repository, runId, page: append && prior ? prior.page + 1 : 1 }
        )
        if (generation.current !== request) {
          return
        }
        setState({
          data: append && prior ? { ...data, items: [...prior.items, ...data.items] } : data,
          loading: false,
          error: null
        })
      } catch (error) {
        if (generation.current === request) {
          setState((s) => ({
            ...s,
            loading: false,
            error: error instanceof Error ? error.message : String(error)
          }))
        }
      }
    },
    [option, runId]
  )
  useEffect(() => {
    alive.current = true
    void read()
    return () => {
      alive.current = false
      generation.current += 1
    }
  }, [read])
  /** Serialize saves for this view and suppress completion updates after unmount or intentional cancellation. */
  const save = async (artifact: ActionsArtifact) => {
    if (download.id !== null) {
      return
    }
    canceled.current = false
    setDownload({ id: artifact.id, percent: 0, error: null, saved: null })
    try {
      const saved = await downloadActionsArtifact(
        {
          repoId: option.repo.id,
          repoPath: option.repo.path,
          ownerKey: actionsRepoProbeKey(option.repo)
        },
        { repository: option.repository, runId, artifactId: artifact.id },
        artifact.name,
        () => alive.current && !canceled.current,
        (percent) => {
          if (alive.current) {
            setDownload((d) => ({ ...d, percent }))
          }
        }
      )
      if (alive.current) {
        setDownload({ id: null, percent: 100, error: null, saved })
      }
    } catch (error) {
      if (alive.current) {
        if (canceled.current) {
          setDownload({ id: null, percent: 0, saved: null, error: null })
          return
        }
        setDownload({
          id: null,
          percent: 0,
          saved: null,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  return {
    ...state,
    download,
    /** Replace the artifact list with a fresh first page while preserving download state. */
    refresh: () => {
      void read()
    },
    /** Append the next artifact page through the same generation fence as initial reads. */
    more: () => {
      void read(true)
    },
    save,
    /** Mark the current save for cancellation at its next transfer boundary without raising an error alert. */
    cancel: () => {
      canceled.current = true
    }
  }
}
