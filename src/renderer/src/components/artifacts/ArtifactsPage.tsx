import { useEffect, useState } from 'react'
import { ArrowRight, Files, Loader2, RefreshCw, X } from 'lucide-react'
import type { ArtifactCloudOperation, ArtifactListItem } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { persistConfirmationSkipPreference } from '@/components/confirmation-skip-preference'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { ArtifactCollection } from './ArtifactCollection'
import { artifactAccountIdentity, useArtifactPagination } from './useArtifactPagination'

const LOCAL_RUNTIME = { kind: 'local' } as const

export default function ArtifactsPage(): React.JSX.Element {
  const closePage = useAppStore((state) => state.closeArtifactsPage)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const refreshAuth = useAppStore((state) => state.refreshCurrentOrcaProfileAuth)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const confirm = useConfirmationDialog()
  // Why: publishing is off by default, so "ask your agent to share" is a dead end until the
  // capability is granted. Only claim that once settings have actually loaded.
  const publishingBlocked = settings ? settings.artifactSharingEnabled !== true : false
  const [deleting, setDeleting] = useState<{ identity: string; slug: string } | null>(null)
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
    error,
    loading,
    loadingMore,
    nextCursor,
    loadArtifacts,
    loadMoreArtifacts,
    removeArtifact,
    setError
  } = useArtifactPagination(authStatus, refreshAuth)
  const deletingId = deleting?.identity === accountIdentity ? deleting.slug : null
  const selectedArtifact =
    artifacts.find(({ artifact }) => artifact.slug === selectedSlug) ?? artifacts[0] ?? null

  useEffect(() => {
    setSelectedSlug((current) => {
      if (current && artifacts.some(({ artifact }) => artifact.slug === current)) {
        return current
      }
      return artifacts[0]?.artifact.slug ?? null
    })
  }, [artifacts])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      // Why: Esc clears field focus before closing the page, matching Automations.
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        event.preventDefault()
        target.blur()
        return
      }
      event.preventDefault()
      closePage()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePage])

  const deleteArtifact = async (item: ArtifactListItem): Promise<void> => {
    const requestedIdentity = accountIdentity
    if (!requestedIdentity) {
      return
    }
    const requestedAccountIsCurrent = (): boolean =>
      artifactAccountIdentity(useAppStore.getState().orcaProfileAuthStatus) === requestedIdentity
    const name = item.artifact.title || item.artifact.originalFileName || item.artifact.slug
    if (!settings?.skipDeleteArtifactConfirm) {
      const accepted = await confirm({
        title: translate('auto.components.artifacts.ArtifactsPage.deleteTitle', 'Delete artifact?'),
        description: translate(
          'auto.components.artifacts.ArtifactsPage.deleteDescription',
          '“{{name}}” will no longer be available at its public link.',
          { name }
        ),
        confirmLabel: translate('auto.components.artifacts.ArtifactsPage.delete', 'Delete'),
        confirmVariant: 'destructive',
        dontAskAgain: {
          onConfirmed: () =>
            persistConfirmationSkipPreference({
              updates: { skipDeleteArtifactConfirm: true },
              settingsSectionId: 'general-skip-delete-artifact-confirm',
              updateSettings,
              openSettingsPage,
              openSettingsTarget
            })
        }
      })
      if (!accepted) {
        return
      }
    }
    if (!requestedAccountIsCurrent()) {
      return
    }
    setDeleting({ identity: requestedIdentity, slug: item.artifact.slug })
    try {
      const result = await callRuntimeRpc<ArtifactCloudOperation<void>>(
        LOCAL_RUNTIME,
        'artifacts.delete',
        { id: item.artifact.slug }
      )
      if (!requestedAccountIsCurrent()) {
        return
      }
      if (result.status !== 'ok') {
        await refreshAuth()
        throw new Error(result.status)
      }
      removeArtifact(requestedIdentity, item.artifact.slug)
    } catch (deleteError) {
      console.error('Failed to delete artifact:', deleteError)
      if (requestedAccountIsCurrent()) {
        setError(
          translate(
            'auto.components.artifacts.ArtifactsPage.deleteFailed',
            'Could not delete the artifact.'
          )
        )
      }
    } finally {
      setDeleting((current) =>
        current?.identity === requestedIdentity && current.slug === item.artifact.slug
          ? null
          : current
      )
    }
  }

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between px-5 pb-3 pt-1.5 md:px-8">
        <div className="flex min-w-0 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 rounded-full"
                onClick={closePage}
                aria-label={translate(
                  'auto.components.artifacts.ArtifactsPage.closeArtifacts',
                  'Close artifacts'
                )}
              >
                <X className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.artifacts.ArtifactsPage.closeTooltip', 'Close · Esc')}
            </TooltipContent>
          </Tooltip>
          <div className="mx-1 h-5 w-px bg-border/50" aria-hidden />
          <Files className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {translate('auto.components.artifacts.ArtifactsPage.title', 'Artifacts')}
            </h1>
            {signedIn && artifacts.length > 0 ? (
              <p className="truncate text-xs text-muted-foreground">
                {nextCursor
                  ? translate(
                      'auto.components.artifacts.ArtifactsPage.loadedCountMore',
                      '{{count}} loaded · more available',
                      { count: artifacts.length }
                    )
                  : translate(
                      'auto.components.artifacts.ArtifactsPage.loadedCount',
                      '{{count}} shared',
                      { count: artifacts.length }
                    )}
              </p>
            ) : null}
          </div>
        </div>
        {signedIn ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="border border-border/50 bg-transparent hover:bg-muted/50"
                onClick={() => void loadArtifacts()}
                disabled={loading}
                aria-label={translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
              >
                <RefreshCw className={loading ? 'animate-spin' : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.artifacts.ArtifactsPage.refresh', 'Refresh')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </header>

      {/* Why: pane edges match the full-bleed Automations layout. */}
      <div className="flex min-h-0 w-full flex-1 flex-col border-t border-border/50">
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/10 px-5 py-2 md:px-8">
            <p className="min-w-0 flex-1 text-xs text-destructive">{error}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={loading}
              onClick={() => void loadArtifacts()}
            >
              {translate('auto.components.artifacts.ArtifactsPage.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        {!signedIn ? (
          <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 px-5 py-5 text-center md:px-8">
            <Files className="size-8 text-muted-foreground" />
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">
                {needsReconnect
                  ? translate(
                      'auto.components.artifacts.ArtifactsPage.reconnectHeading',
                      'Sign in to Orca again'
                    )
                  : translate(
                      'auto.components.artifacts.ArtifactsPage.signInHeading',
                      'Sign in to share artifacts'
                    )}
              </h2>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                {needsReconnect
                  ? translate(
                      'auto.components.artifacts.ArtifactsPage.reconnectCopy',
                      'Sign in again to view and manage the artifacts shared through your account.'
                    )
                  : translate(
                      'auto.components.artifacts.ArtifactsPage.signInCopy',
                      'Use your Orca account to upload artifacts and manage their public links.'
                    )}
              </p>
            </div>
            {authStatus?.configured === true ? (
              <Button size="sm" disabled={connecting} onClick={() => void connect()}>
                {connecting
                  ? translate('auto.components.artifacts.ArtifactsPage.signingIn', 'Signing in…')
                  : needsReconnect
                    ? translate(
                        'auto.components.artifacts.ArtifactsPage.signInAgainAction',
                        'Sign in again'
                      )
                    : translate(
                        'auto.components.artifacts.ArtifactsPage.signIn',
                        'Sign in to Orca'
                      )}
              </Button>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                  {translate(
                    'auto.components.artifacts.ArtifactsPage.unconfiguredCopy',
                    'Orca account sign-in is not configured on this machine yet.'
                  )}
                </p>
                <Button variant="outline" size="sm" onClick={openAccountSettings}>
                  {translate(
                    'auto.components.artifacts.ArtifactsPage.openAccountSettings',
                    'Open account settings'
                  )}
                  <ArrowRight />
                </Button>
              </div>
            )}
          </div>
        ) : loading && artifacts.length === 0 ? (
          <div className="flex min-h-72 flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : artifacts.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-5 text-center md:px-8">
            <Files className="size-8 text-muted-foreground" />
            <h2 className="text-sm font-semibold">
              {nextCursor
                ? translate(
                    'auto.components.artifacts.ArtifactsPage.moreAvailable',
                    'More artifacts are available'
                  )
                : publishingBlocked
                  ? translate(
                      'auto.components.artifacts.ArtifactsPage.publishingOff',
                      'Publishing is turned off'
                    )
                  : translate(
                      'auto.components.artifacts.ArtifactsPage.empty',
                      'No shared artifacts'
                    )}
            </h2>
            <p className="max-w-sm text-xs leading-5 text-muted-foreground">
              {nextCursor
                ? translate(
                    'auto.components.artifacts.ArtifactsPage.moreAvailableCopy',
                    'Load the next page to continue.'
                  )
                : publishingBlocked
                  ? translate(
                      'auto.components.artifacts.ArtifactsPage.publishingOffCopy',
                      'Nothing on this device can create a public artifact link yet. Allow publishing in Settings → Artifacts, then share from an open HTML or Markdown file or ask your agent.'
                    )
                  : translate(
                      'auto.components.artifacts.ArtifactsPage.emptyCopy',
                      'Open an HTML or Markdown file and select Share as artifact, or ask your agent to share it.'
                    )}
            </p>
            {!nextCursor && publishingBlocked ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1"
                onClick={() => {
                  openSettingsTarget({ pane: 'artifacts', repoId: null })
                  openSettingsPage()
                }}
              >
                {translate(
                  'auto.components.artifacts.ArtifactsPage.openArtifactsSettings',
                  'Open Settings → Artifacts'
                )}
              </Button>
            ) : null}
            {nextCursor ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-1"
                disabled={loadingMore}
                onClick={() => void loadMoreArtifacts()}
              >
                {loadingMore ? <Loader2 className="animate-spin" /> : null}
                {translate('auto.components.artifacts.ArtifactCollection.loadMore', 'Load more')}
              </Button>
            ) : null}
          </div>
        ) : (
          selectedArtifact && (
            <ArtifactCollection
              artifacts={artifacts}
              deletingId={deletingId}
              selectedArtifact={selectedArtifact}
              selectArtifact={setSelectedSlug}
              deleteArtifact={(target) => void deleteArtifact(target)}
              hasMore={Boolean(nextCursor)}
              loadingMore={loadingMore}
              loadMore={() => void loadMoreArtifacts()}
            />
          )
        )}
      </div>
    </main>
  )
}
