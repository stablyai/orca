import { useState } from 'react'
import { ArrowRight, Loader2, Share2 } from 'lucide-react'
import type { ArtifactPublishResult, ArtifactWriteRequest } from '../../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { publishArtifactFromSurface } from './artifact-publish-flow'

export function ArtifactPublishButton({
  createRequest,
  className,
  disabled,
  onPublished
}: {
  createRequest: () => Promise<ArtifactWriteRequest>
  className?: string
  disabled?: boolean
  onPublished?: (result: ArtifactPublishResult) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const settings = useAppStore((state) => state.settings)
  const signedIn = authStatus?.state === 'connected'
  const sharingEnabled = settings?.artifactSharingEnabled === true
  const busy = publishing || connecting
  const blocked = disabled || busy

  const publish = async (): Promise<void> => {
    if (blocked || !signedIn || !sharingEnabled) {
      return
    }
    setPublishing(true)
    try {
      const result = await publishArtifactFromSurface(createRequest)
      if (result) {
        setOpen(false)
        onPublished?.(result)
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

      <PopoverContent align="end" sideOffset={6} className="w-80 p-0">
        <div className="space-y-1 border-b border-border/60 px-4 py-3.5">
          <h3 className="text-sm font-semibold">
            {translate(
              'auto.components.artifacts.ArtifactPublishButton.confirmTitle',
              'Share as artifact'
            )}
          </h3>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate(
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
        </div>
      </PopoverContent>
    </Popover>
  )
}
