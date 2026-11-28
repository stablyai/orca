import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaTeamFeatureBlocked } from '@/lib/orca-team-policy'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS } from '../../../../shared/orca-profiles/orca-cloud-team-policy'
import { ArtifactCollection } from './ArtifactCollection'
import { RailPage } from '@/components/rail-page/RailPage'
import { RailPageHeader, RailPageRefreshButton } from '@/components/rail-page/RailPageHeader'
import { ArtifactDetailDrawer } from './ArtifactDetailDrawer'
import { ArtifactsPageSkeleton } from './ArtifactsPageSkeleton'
import {
  ArtifactsPageAuthState,
  ArtifactsPageEmptyState,
  ArtifactsPageErrorBanner
} from './ArtifactsPageStates'
import { useArtifactPagination } from './useArtifactPagination'
import { useArtifactDeletion } from './use-artifact-deletion'

export default function ArtifactsPage(): React.JSX.Element {
  const t = useTranslate()
  const closePage = useAppStore((state) => state.closeArtifactsPage)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const refreshAuth = useAppStore((state) => state.refreshCurrentOrcaProfileAuth)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  // Claim publishing is blocked only after settings load; sharing requires explicit capability opt-in.
  const publishingBlockedByTeam = useOrcaTeamFeatureBlocked(
    ORCA_CLOUD_TEAM_POLICY_FLAGS.artifactSharing
  )
  const publishingBlocked = settings ? settings.artifactSharingEnabled !== true : false
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const signedIn = authStatus?.state === 'connected'
  const needsReconnect = authStatus?.state === 'reconnect-required'
  const openAccountSettings = (): void => {
    openSettingsTarget({ pane: 'orca-account', repoId: null })
    openSettingsPage()
  }
  const {
    accountIdentity,
    artifacts,
    hasLoadedCurrentPage,
    error,
    loading,
    loadingMore,
    nextCursor,
    loadArtifacts,
    loadMoreArtifacts,
    removeArtifact,
    setError
  } = useArtifactPagination(authStatus, refreshAuth)
  const { deletingSlugs, deleteArtifacts } = useArtifactDeletion({
    accountIdentity,
    refreshAuth,
    removeArtifact,
    setError
  })
  const clearSelectionRef = useRef<(() => boolean) | null>(null)
  const selectedArtifact =
    selectedSlug === null
      ? null
      : (artifacts.find(({ artifact }) => artifact.slug === selectedSlug) ?? null)

  if (selectedSlug !== null && selectedArtifact === null) {
    // Drop a vanished selection during render so a later reload cannot reopen it.
    setSelectedSlug(null)
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (target.dataset.escapeClearsValue === 'true') {
        return
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      if (selectedSlug) {
        event.preventDefault()
        setSelectedSlug(null)
        return
      }
      if (clearSelectionRef.current?.()) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      closePage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePage, selectedSlug])

  // A true total only (D1 R6): every page is loaded, nothing is loading and the last load did not fail.
  const artifactCount =
    signedIn && hasLoadedCurrentPage && !loading && !error && !nextCursor ? artifacts.length : null
  const errorNotice = error ? (
    <ArtifactsPageErrorBanner
      error={error}
      loading={loading}
      onRetry={() => void loadArtifacts()}
    />
  ) : null

  return (
    <RailPage as="main">
      <RailPageHeader
        title={t('auto.components.artifacts.ArtifactsPage.title', 'Artifacts')}
        count={artifactCount}
        actions={
          signedIn ? (
            <RailPageRefreshButton
              label={t('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
              busy={loading}
              onRefresh={() => void loadArtifacts()}
            />
          ) : null
        }
      />
      {!signedIn ? (
        <>
          {errorNotice}
          <ArtifactsPageAuthState
            needsReconnect={needsReconnect}
            configured={authStatus?.configured === true}
            onOpenAccountSettings={openAccountSettings}
          />
        </>
      ) : loading && artifacts.length === 0 ? (
        <>
          {errorNotice}
          <ArtifactsPageSkeleton />
        </>
      ) : artifacts.length === 0 ? (
        <>
          {errorNotice}
          <ArtifactsPageEmptyState
            hasMore={Boolean(nextCursor)}
            loadingMore={loadingMore}
            publishingBlocked={publishingBlocked}
            publishingBlockedByTeam={publishingBlockedByTeam}
            onLoadMore={() => void loadMoreArtifacts()}
            onOpenArtifactsSettings={() => {
              openSettingsTarget({ pane: 'artifacts', repoId: null })
              openSettingsPage()
            }}
          />
        </>
      ) : (
        <ArtifactCollection
          artifacts={artifacts}
          deletingSlugs={deletingSlugs}
          selectedSlug={selectedSlug}
          selectArtifact={setSelectedSlug}
          deleteArtifacts={deleteArtifacts}
          clearSelectionRef={clearSelectionRef}
          hasMore={Boolean(nextCursor)}
          loadingMore={loadingMore}
          loadMore={() => void loadMoreArtifacts()}
          notice={errorNotice}
        />
      )}

      <ArtifactDetailDrawer
        item={selectedArtifact}
        deleting={selectedArtifact ? deletingSlugs.has(selectedArtifact.artifact.slug) : false}
        onClose={() => setSelectedSlug(null)}
        onDelete={(target) => void deleteArtifacts([target])}
      />
    </RailPage>
  )
}
