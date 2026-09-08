import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { GitHubProjectSummary } from '../../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'
import {
  getProjectPickerBrowseCacheEntry,
  peekProjectPickerBrowseCacheEntry,
  rememberProjectPickerBrowseCacheEntry
} from './project-picker-browse-cache'
import {
  getProjectPickerRuntimeScope,
  listAccessibleProjectsForRuntime
} from './project-picker-runtime'

export function useProjectPickerBrowse(
  settings: Parameters<typeof getProjectPickerRuntimeScope>[0],
  browseHost: string
): {
  browseProjects: GitHubProjectSummary[]
  partialFailures: { owner: string; message: string }[]
  browseLoading: boolean
  browseError: GitHubProjectViewError | null
  loadBrowse: () => Promise<void>
} {
  const mountedRef = useMountedRef()
  const cacheKey = getProjectPickerRuntimeScope(settings, browseHost)
  const activeCacheKeyRef = useRef(cacheKey)
  useLayoutEffect(() => {
    activeCacheKeyRef.current = cacheKey
  }, [cacheKey])
  const cached = peekProjectPickerBrowseCacheEntry(cacheKey)
  const [browseProjects, setBrowseProjects] = useState<GitHubProjectSummary[]>(
    () => cached?.projects ?? []
  )
  const [partialFailures, setPartialFailures] = useState<{ owner: string; message: string }[]>(
    () => cached?.partialFailures ?? []
  )
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<GitHubProjectViewError | null>(null)

  const loadBrowse = useCallback(async () => {
    const cachedEntry = getProjectPickerBrowseCacheEntry(cacheKey)
    if (cachedEntry) {
      setBrowseLoading(false)
      setBrowseError(null)
      setBrowseProjects(cachedEntry.projects)
      setPartialFailures(cachedEntry.partialFailures ?? [])
      return
    }
    setBrowseLoading(true)
    setBrowseError(null)
    setBrowseProjects([])
    setPartialFailures([])
    try {
      const result = await listAccessibleProjectsForRuntime(settings, browseHost)
      if (result.ok) {
        rememberProjectPickerBrowseCacheEntry(cacheKey, {
          projects: result.projects,
          partialFailures: result.partialFailures
        })
      }
      if (!mountedRef.current || activeCacheKeyRef.current !== cacheKey) {
        return
      }
      if (result.ok) {
        setBrowseProjects(result.projects)
        setPartialFailures(result.partialFailures ?? [])
      } else {
        setBrowseError(result.error)
      }
    } catch (error) {
      if (mountedRef.current && activeCacheKeyRef.current === cacheKey) {
        setBrowseError({
          type: 'unknown',
          message: error instanceof Error ? error.message : 'Failed to list projects'
        })
      }
    } finally {
      if (mountedRef.current && activeCacheKeyRef.current === cacheKey) {
        setBrowseLoading(false)
      }
    }
  }, [browseHost, cacheKey, mountedRef, settings])

  return { browseProjects, partialFailures, browseLoading, browseError, loadBrowse }
}
