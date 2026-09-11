import { useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronDown, CircleUserRound, Files, Smartphone, X } from 'lucide-react'
import { useAppStore } from '../store'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { shouldShowUnexpectedSignoutCard } from './unexpected-signout/unexpected-signout-visibility'

function readPreviewFlag(): boolean {
  if (!import.meta.env.DEV) {
    return false
  }
  try {
    if (new URLSearchParams(window.location.search).get('showSignoutCard') === '1') {
      return true
    }
    return window.localStorage.getItem('orca-debug-show-signout-card') === '1'
  } catch {
    return false
  }
}

function FeatureRow({
  icon: Icon,
  title,
  description
}: {
  icon: typeof Files
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}

export function UnexpectedSignoutCard(): React.JSX.Element | null {
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const persistedDismissedVersion = useAppStore((s) => s.dismissedUnexpectedSignoutVersion)
  const dismissedVersions = useAppStore((s) => s.unexpectedSignoutDismissedVersions)
  const dismissForVersion = useAppStore((s) => s.dismissUnexpectedSignoutCard)
  const connecting = useAppStore((s) => s.orcaProfileConnecting)
  const connect = useAppStore((s) => s.connectCurrentOrcaProfile)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [preview] = useState(readPreviewFlag)
  const [previewDismissed, setPreviewDismissed] = useState(false)
  const reconnectingProfile = useRef<string | null>(null)

  useOrcaProfileAuthStatusRefresh()

  useEffect(() => {
    let cancelled = false
    void window.api.updater
      .getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismissedVersion =
    appVersion && dismissedVersions.includes(appVersion) ? appVersion : persistedDismissedVersion
  const eligible = shouldShowUnexpectedSignoutCard({
    authStatus,
    persistedUIReady,
    appVersion,
    dismissedVersion
  })

  const visible = preview ? persistedUIReady && !previewDismissed : eligible

  // Observe recovery independently of visibility and asynchronous version/hydration reads.
  useEffect(() => {
    if (preview) {
      return
    }
    if (authStatus?.state === 'reconnect-required' && authStatus.configured && authStatus.cloud) {
      reconnectingProfile.current = authStatus.activeProfileId
    } else if (authStatus?.state === 'connected') {
      if (
        reconnectingProfile.current === authStatus.activeProfileId &&
        persistedUIReady &&
        appVersion
      ) {
        reconnectingProfile.current = null
        if (dismissedVersion !== appVersion) {
          dismissForVersion(appVersion)
        }
      }
    } else {
      reconnectingProfile.current = null
    }
  }, [preview, authStatus, persistedUIReady, appVersion, dismissedVersion, dismissForVersion])

  if (!visible) {
    return null
  }

  const email = authStatus?.cloud?.email?.trim() || null
  const canConnect = authStatus?.configured === true

  const handleDismiss = (): void => {
    if (preview) {
      setPreviewDismissed(true)
    } else if (appVersion) {
      dismissForVersion(appVersion)
    }
  }

  return (
    <div>
      <Card
        className="py-0 gap-0 shadow-floating"
        role="complementary"
        aria-live="polite"
        aria-labelledby="unexpected-signout-heading"
      >
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <CircleUserRound className="size-4 text-muted-foreground" />
              <h3 id="unexpected-signout-heading" className="text-sm font-semibold">
                {translate(
                  'auto.components.UnexpectedSignoutCard.9f2c1a4b7d',
                  "You've been signed out"
                )}
              </h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleDismiss}
              aria-label={translate('auto.components.UnexpectedSignoutCard.3e8f5c2a91', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {email
              ? translate(
                  'auto.components.UnexpectedSignoutCard.7b4d9e1f2a',
                  'Sign in again as {{value0}} to restore Artifact sharing, Orca Relay, and skill sharing.',
                  { value0: email }
                )
              : translate(
                  'auto.components.UnexpectedSignoutCard.5a1c8d3e6f',
                  'Sign in again to restore Artifact sharing, Orca Relay, and skill sharing.'
                )}
          </p>

          <Collapsible open={expanded} onOpenChange={setExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="w-fit gap-1 px-1 text-xs text-muted-foreground"
                aria-expanded={expanded}
              >
                {translate('auto.components.UnexpectedSignoutCard.1f6b2c9d4e', 'What you get back')}
                <ChevronDown
                  className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-2.5">
              <FeatureRow
                icon={Files}
                title={translate(
                  'auto.components.UnexpectedSignoutCard.8d2e4f7a1b',
                  'Artifact sharing'
                )}
                description={translate(
                  'auto.components.UnexpectedSignoutCard.2c9a5b6e8d',
                  'Publish HTML and Markdown files and manage every shared link from Orca.'
                )}
              />
              <FeatureRow
                icon={Smartphone}
                title={translate('auto.components.UnexpectedSignoutCard.6e3f1a9c5b', 'Orca Relay')}
                description={translate(
                  'auto.components.UnexpectedSignoutCard.4b7d2e8f1a',
                  'Connect Orca Mobile to this desktop across cellular or any Wi-Fi.'
                )}
              />
              <FeatureRow
                icon={BookOpen}
                title={translate(
                  'auto.components.UnexpectedSignoutCard.9a4c6b2d7e',
                  'Skill sharing'
                )}
                description={translate(
                  'auto.components.UnexpectedSignoutCard.3d8e5f1b9c',
                  'Share skills behind an unlisted link and install them on any machine you use.'
                )}
              />
            </CollapsibleContent>
          </Collapsible>

          <div className="mt-0.5 flex gap-2">
            <Button
              variant="default"
              size="sm"
              className="flex-1"
              disabled={!canConnect || connecting}
              onClick={() => void connect()}
            >
              {connecting
                ? translate('auto.components.UnexpectedSignoutCard.7e1a9c4d2f', 'Signing in…')
                : translate('auto.components.UnexpectedSignoutCard.c5b3e8a17d', 'Sign in to Orca')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
