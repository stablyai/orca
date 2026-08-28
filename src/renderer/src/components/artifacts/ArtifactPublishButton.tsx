import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Loader2, Share2 } from 'lucide-react'
import type { ArtifactWriteRequest } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { ArtifactPublishedLinkPanel } from './ArtifactPublishedLinkPanel'
import { getPublishedArtifactLink } from './artifact-published-link-client'
import { publishArtifactFromSurface } from './artifact-publish-flow'

type PublishedLinkLookup = {
  key: string
  status: 'loading' | 'loaded' | 'error'
  shareUrl: string | null
}

export function ArtifactPublishButton({
  sourceKey,
  createRequest,
  className,
  disabled
}: {
  sourceKey: string
  createRequest: () => Promise<ArtifactWriteRequest>
  className?: string
  disabled?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [lookupRevision, setLookupRevision] = useState(0)
  const [linkLookup, setLinkLookup] = useState<PublishedLinkLookup | null>(null)
  const lookupSequence = useRef(0)
  const popoverContentRef = useRef<HTMLDivElement>(null)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const signedIn = authStatus?.state === 'connected'
  const sharingEnabled = settings?.artifactSharingEnabled === true
  const accountKey =
    authStatus?.state === 'connected'
      ? JSON.stringify([
          authStatus.activeProfileId,
          authStatus.cloud?.userId ?? null,
          authStatus.cloud?.cloudProfileId ?? null,
          authStatus.cloud?.activeOrgId ?? null
        ])
      : null
  const lookupKey = accountKey ? JSON.stringify([accountKey, sourceKey]) : null
  const currentLookup = linkLookup?.key === lookupKey ? linkLookup : null
  const checkingLink =
    signedIn && currentLookup?.status !== 'loaded' && currentLookup?.status !== 'error'
  const publishedLink = currentLookup?.status === 'loaded' ? currentLookup.shareUrl : null
  const busy = publishing || connecting
  const blocked = disabled || busy

  useEffect(() => {
    const sequence = ++lookupSequence.current
    if (!open || !lookupKey) {
      setLinkLookup(null)
      return
    }
    setLinkLookup({ key: lookupKey, status: 'loading', shareUrl: null })
    void getPublishedArtifactLink(sourceKey)
      .then((shareUrl) => {
        if (lookupSequence.current === sequence) {
          setLinkLookup({ key: lookupKey, status: 'loaded', shareUrl })
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to check published artifact link:', error)
        if (lookupSequence.current === sequence) {
          setLinkLookup({ key: lookupKey, status: 'error', shareUrl: null })
        }
      })
    return () => {
      lookupSequence.current += 1
    }
  }, [lookupKey, lookupRevision, open, sourceKey])

  const publish = async (): Promise<void> => {
    if (blocked || !signedIn || !sharingEnabled) {
      return
    }
    setPublishing(true)
    try {
      const result = await publishArtifactFromSurface(createRequest)
      if (result) {
        if (lookupKey) {
          setLinkLookup({ key: lookupKey, status: 'loaded', shareUrl: result.item.shareUrl })
        }
      }
    } finally {
      setPublishing(false)
    }
  }

  const openArtifactsSettings = (): void => {
    setOpen(false)
    openSettingsTarget({ pane: 'artifacts', repoId: null })
    openSettingsPage()
  }

  const label = translate(
    'auto.components.artifacts.ArtifactPublishButton.a4a49da6af',
    'Share as artifact'
  )
  return (
    <Popover open={open} onOpenChange={(nextOpen) => !busy && setOpen(nextOpen)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className={cn('shrink-0', className)}
              disabled={blocked}
              aria-label={label}
            >
              {publishing ? <Loader2 className="animate-spin" /> : <Share2 />}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        ref={popoverContentRef}
        tabIndex={-1}
        align="end"
        sideOffset={6}
        className="w-80 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          popoverContentRef.current?.focus({ preventScroll: true })
        }}
      >
        <div className="space-y-1 border-b border-border/60 px-4 py-3.5">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.artifacts.ArtifactPublishButton.confirmTitle',
              'Share as artifact'
            )}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {publishedLink
              ? translate(
                  'auto.components.artifacts.ArtifactPublishButton.publishedDescription',
                  'Anyone with this link can view the shared file.'
                )
              : translate(
                  'auto.components.artifacts.ArtifactPublishButton.confirmDescription',
                  'This publishes the current file at a link anyone with the URL can view.'
                )}
          </p>
        </div>

        <div className="space-y-3 p-4">
          {!signedIn ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <p className="text-xs font-medium">
                  {translate(
                    'auto.components.artifacts.ArtifactPublishButton.accountTitle',
                    'Orca account'
                  )}
                </p>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {translate(
                    'auto.components.artifacts.ArtifactPublishButton.accountDescription',
                    'Sign in to create and manage this link.'
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={connecting || authStatus?.configured !== true}
                onClick={() => void connect()}
              >
                {connecting
                  ? translate(
                      'auto.components.artifacts.ArtifactPublishButton.signingIn',
                      'Signing in…'
                    )
                  : authStatus?.state === 'reconnect-required'
                    ? translate(
                        'auto.components.artifacts.ArtifactPublishButton.signInAgain',
                        'Sign in again'
                      )
                    : translate(
                        'auto.components.artifacts.ArtifactPublishButton.signIn',
                        'Sign in'
                      )}
              </Button>
            </div>
          ) : null}

          {!sharingEnabled ? (
            <div className={cn('space-y-2', !signedIn && 'border-t border-border/60 pt-3')}>
              <div className="space-y-0.5">
                <p className="text-xs font-medium">
                  {translate(
                    'auto.components.artifacts.ArtifactPublishButton.publishingOffTitle',
                    'Artifact sharing is off'
                  )}
                </p>
                <p className="text-[11px] leading-4 text-muted-foreground">
                  {translate(
                    'auto.components.artifacts.ArtifactPublishButton.publishingOffDescription',
                    'Learn about public links and enable sharing in Settings.'
                  )}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={openArtifactsSettings}
              >
                {translate(
                  'auto.components.artifacts.ArtifactPublishButton.openSettings',
                  'Open Artifacts settings'
                )}
                <ArrowRight />
              </Button>
            </div>
          ) : null}

          {checkingLink ? (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.artifacts.ArtifactPublishButton.checkingLink',
                'Checking for an existing link…'
              )}
            </div>
          ) : currentLookup?.status === 'error' ? (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.artifacts.ArtifactPublishButton.checkFailed',
                  'Could not check for an existing link.'
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setLookupRevision((current) => current + 1)}
              >
                {translate('auto.components.artifacts.ArtifactPublishButton.tryAgain', 'Try again')}
              </Button>
            </div>
          ) : publishedLink ? (
            <ArtifactPublishedLinkPanel
              key={publishedLink}
              shareUrl={publishedLink}
              publishing={publishing}
              sharingEnabled={sharingEnabled}
              onUpdate={() => void publish()}
            />
          ) : (
            <Button
              type="button"
              size="sm"
              className="w-full"
              disabled={!signedIn || !sharingEnabled || busy}
              onClick={() => void publish()}
            >
              {publishing ? <Loader2 className="animate-spin" /> : <Share2 />}
              {publishing
                ? translate('auto.components.artifacts.ArtifactPublishButton.sharing', 'Sharing…')
                : translate(
                    'auto.components.artifacts.ArtifactPublishButton.sharePublicLink',
                    'Share public link'
                  )}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
