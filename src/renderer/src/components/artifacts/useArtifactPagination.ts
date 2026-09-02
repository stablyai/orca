import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactListPage
} from '../../../../shared/artifacts'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'

const LOCAL_RUNTIME = { kind: 'local' } as const
const EMPTY_ARTIFACTS: readonly ArtifactListItem[] = []

export function artifactAccountIdentity(authStatus: OrcaProfileAuthStatus | null): string | null {
  return authStatus?.state === 'connected'
    ? `${authStatus.activeProfileId}:${authStatus.cloud?.userId ?? ''}:${authStatus.cloud?.cloudProfileId ?? ''}:${authStatus.cloud?.activeOrgId ?? ''}`
    : null
}

function appendArtifactPage(
  current: readonly ArtifactListItem[],
  incoming: readonly ArtifactListItem[]
): readonly ArtifactListItem[] {
  const knownSlugs = new Set(current.map(({ artifact }) => artifact.slug))
  return [...current, ...incoming.filter(({ artifact }) => !knownSlugs.has(artifact.slug))]
}

function artifactRequestIsCurrent(
  sequence: number,
  currentSequence: number,
  identity: string
): boolean {
  return (
    sequence === currentSequence &&
    artifactAccountIdentity(useAppStore.getState().orcaProfileAuthStatus) === identity
  )
}

export function useArtifactPagination(
  authStatus: OrcaProfileAuthStatus | null,
  refreshAuth: () => Promise<unknown>
): {
  accountIdentity: string | null
  artifacts: readonly ArtifactListItem[]
  error: string | null
  loading: boolean
  loadingMore: boolean
  nextCursor?: string
  loadArtifacts: () => Promise<void>
  loadMoreArtifacts: () => Promise<void>
  removeArtifact: (identity: string, slug: string) => void
  setError: (error: string | null) => void
} {
  const accountIdentity = artifactAccountIdentity(authStatus)
  const [artifactState, setArtifactState] = useState<{
    identity: string | null
    page: ArtifactListPage
  }>({ identity: null, page: { artifacts: [] } })
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadSequence = useRef(0)
  const loadingCursor = useRef<string | null>(null)
  const currentPage = artifactState.identity === accountIdentity ? artifactState.page : null
  const artifacts = currentPage?.artifacts ?? EMPTY_ARTIFACTS

  const loadArtifacts = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current
    loadingCursor.current = null
    setLoadingMore(false)
    if (!accountIdentity) {
      setArtifactState({ identity: null, page: { artifacts: [] } })
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactListPage>>(
        LOCAL_RUNTIME,
        'artifacts.list',
        {}
      )
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      if (result.status === 'ok') {
        setArtifactState({ identity: accountIdentity, page: result.value })
      } else {
        await refreshAuth()
        if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
          return
        }
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.signInAgain',
            'Sign in to Orca again to load artifacts.'
          )
        )
      }
    } catch (loadError) {
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      console.error('Failed to load artifacts:', loadError)
      setError(
        translate('auto.components.artifacts.ArtifactsPage.loadFailed', 'Could not load artifacts.')
      )
    } finally {
      if (artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        setLoading(false)
      }
    }
  }, [accountIdentity, refreshAuth])

  useEffect(() => {
    void loadArtifacts()
    return () => {
      loadSequence.current += 1
    }
  }, [loadArtifacts])

  const loadMoreArtifacts = useCallback(async (): Promise<void> => {
    const cursor = currentPage?.nextCursor
    if (!accountIdentity || !cursor || loadingCursor.current) {
      return
    }
    const sequence = loadSequence.current
    loadingCursor.current = cursor
    setLoadingMore(true)
    setError(null)
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<ArtifactListPage>>(
        LOCAL_RUNTIME,
        'artifacts.list',
        { cursor }
      )
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      if (result.status !== 'ok') {
        await refreshAuth()
        if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
          return
        }
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.signInAgain',
            'Sign in to Orca again to load artifacts.'
          )
        )
        return
      }
      setArtifactState((current) =>
        current.identity === accountIdentity
          ? {
              identity: current.identity,
              page: {
                artifacts: appendArtifactPage(current.page.artifacts, result.value.artifacts),
                ...(result.value.nextCursor && result.value.nextCursor !== cursor
                  ? { nextCursor: result.value.nextCursor }
                  : {})
              }
            }
          : current
      )
    } catch (loadError) {
      if (!artifactRequestIsCurrent(sequence, loadSequence.current, accountIdentity)) {
        return
      }
      console.error('Failed to load more artifacts:', loadError)
      setError(
        translate(
          'auto.components.artifacts.ArtifactsPage.loadMoreFailed',
          'Could not load more artifacts.'
        )
      )
    } finally {
      if (loadingCursor.current === cursor) {
        loadingCursor.current = null
        setLoadingMore(false)
      }
    }
  }, [accountIdentity, currentPage?.nextCursor, refreshAuth])

  const removeArtifact = useCallback((identity: string, slug: string): void => {
    loadSequence.current += 1
    loadingCursor.current = null
    setLoading(false)
    setLoadingMore(false)
    setArtifactState((current) =>
      current.identity === identity
        ? {
            ...current,
            page: {
              ...current.page,
              artifacts: current.page.artifacts.filter((item) => item.artifact.slug !== slug)
            }
          }
        : current
    )
  }, [])

  return {
    accountIdentity,
    artifacts,
    error,
    loading,
    loadingMore,
    nextCursor: currentPage?.nextCursor,
    loadArtifacts,
    loadMoreArtifacts,
    removeArtifact,
    setError
  }
}
