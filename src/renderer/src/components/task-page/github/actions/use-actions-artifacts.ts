import { useCallback, useEffect, useRef, useState } from 'react'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { fetchActionsArtifacts } from '@/store/github/actions-artifact-requests'
import { actionsRepoProbeKey } from '@/components/right-sidebar/actions-repositories'
import type { ActionsRepositoryOption } from '@/components/right-sidebar/use-actions-repositories'
import type { ActionsPage } from '../../../../../../shared/github/actions-types'
import type { ActionsArtifact } from '../../../../../../shared/github/actions-artifact-types'
import { downloadActionsArtifact } from './download-actions-artifact'
/** Fence paginated artifact reads and coordinate one cancelable save without treating intentional cancel as an error. */
export function useActionsArtifacts(option: ActionsRepositoryOption, runId: number) {
  const { id: repoId, path: repoPath } = option.repo
  const ownerKey = actionsRepoProbeKey(option.repo)
  const { owner, repo: repoName, host } = option.repository
  const [state, setState] = useState<{
    data: ActionsPage<ActionsArtifact> | null
    loading: boolean
    error: string | null
  }>({ data: null, loading: true, error: null })
  const [download, setDownload] = useState<{
    id: number | null
    percent: number
    saving: boolean
    error: string | null
    saved: string | null
  }>({ id: null, percent: 0, saving: false, error: null, saved: null })
  const current = useRef(state)
  current.current = state
  const generation = useRef(0)
  const alive = useRef(true)
  const activeDownload = useRef<{ canceled: boolean; saving: boolean } | null>(null)
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
            repoId,
            repoPath,
            ownerKey
          },
          {
            repository: { owner, repo: repoName, host },
            runId,
            page: append && prior ? prior.page + 1 : 1
          }
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
    [repoId, repoPath, ownerKey, owner, repoName, host, runId]
  )
  useEffect(() => {
    alive.current = true
    setState({ data: null, loading: true, error: null })
    setDownload({ id: null, percent: 0, saving: false, error: null, saved: null })
    void read()
    return () => {
      alive.current = false
      activeDownload.current = null
      generation.current += 1
    }
  }, [read])
  /** Keep each save owned by its view, including cleanup after cancellation or navigation. */
  const save = async (artifact: ActionsArtifact) => {
    if (activeDownload.current || isWebClientLocation()) {
      return
    }
    const operation = { canceled: false, saving: false }
    activeDownload.current = operation
    const currentDownload = () => alive.current && activeDownload.current === operation
    setDownload({ id: artifact.id, percent: 0, saving: false, error: null, saved: null })
    try {
      const saved = await downloadActionsArtifact(
        {
          repoId,
          repoPath,
          ownerKey
        },
        { repository: { owner, repo: repoName, host }, runId, artifactId: artifact.id },
        artifact.name,
        () => currentDownload() && !operation.canceled,
        (percent) => {
          if (currentDownload()) {
            setDownload((d) => ({ ...d, percent }))
          }
        },
        () => {
          operation.saving = true
          if (currentDownload()) {
            setDownload((d) => ({ ...d, saving: true }))
          }
        }
      )
      if (currentDownload()) {
        setDownload({ id: null, percent: 100, saving: false, error: null, saved })
      }
    } catch (error) {
      if (currentDownload()) {
        setDownload({
          id: null,
          percent: 0,
          saving: false,
          saved: null,
          error: operation.canceled ? null : error instanceof Error ? error.message : String(error)
        })
      }
    } finally {
      if (activeDownload.current === operation) {
        activeDownload.current = null
      }
    }
  }
  return {
    ...state,
    download,
    supportsDownload: !isWebClientLocation(),
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
      const operation = activeDownload.current
      if (operation && !operation.saving) {
        operation.canceled = true
      }
    }
  }
}
