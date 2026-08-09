import { useEffect } from 'react'
import { ArrowRight, Files } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { SettingsSwitchRow } from './SettingsFormControls'
import { useAppStore } from '@/store'
import { isWebClientLocation } from '@/lib/web-client-location'
import { translate } from '@/i18n/i18n'

type HowToStep = { key: string; title: string; description: string }

export function ArtifactsSettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const openArtifactsPage = useAppStore((state) => state.openArtifactsPage)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const fetchAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  const signedIn = authStatus?.state === 'connected'
  // Why: the capability lives in the desktop host's store and is deliberately absent from the
  // settings.update allowlist, so a web client can only mirror it — never grant it.
  const isWebClient = isWebClientLocation()
  const sharingEnabled = settings.artifactSharingEnabled === true

  useEffect(() => {
    if (!authStatus) {
      void fetchAuthStatus()
    }
  }, [authStatus, fetchAuthStatus])

  const howToSteps: HowToStep[] = [
    ...(sharingEnabled
      ? []
      : [
          {
            key: 'enable',
            title: translate(
              'auto.components.settings.artifacts.enableStepTitle',
              'Allow publishing first'
            ),
            description: isWebClient
              ? translate(
                  'auto.components.settings.artifacts.enableStepWebDescription',
                  'Open Settings → Artifacts in the Orca desktop app on the host device and turn publishing on. Until then every share fails with artifact_sharing_disabled.'
                )
              : translate(
                  'auto.components.settings.artifacts.enableStepDescription',
                  'Turn on “Allow publishing public artifact links” above. Until then every share fails with artifact_sharing_disabled.'
                )
          }
        ]),
    {
      key: 'share',
      title: translate(
        'auto.components.settings.artifacts.shareStepTitle',
        'Ask your agent to share it'
      ),
      description: translate(
        'auto.components.settings.artifacts.shareStepDescription',
        'For example: “Share this HTML mock as an artifact.”'
      )
    },
    {
      key: 'link',
      title: translate('auto.components.settings.artifacts.linkStepTitle', 'Share the public link'),
      description: translate(
        'auto.components.settings.artifacts.linkStepDescription',
        'Your agent returns a link that anyone with the URL can view.'
      )
    },
    {
      key: 'manage',
      title: translate('auto.components.settings.artifacts.manageStepTitle', 'Manage it in Orca'),
      description: translate(
        'auto.components.settings.artifacts.manageStepDescription',
        'Open Artifacts from the sidebar to revisit or delete links owned by your account.'
      )
    }
  ]

  return (
    <div className="divide-y divide-border">
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.artifacts.allowPublishing',
          'Allow publishing public artifact links'
        )}
        description={
          isWebClient
            ? translate(
                'auto.components.settings.artifacts.allowPublishingWebDescription',
                'Desktop only. This capability is granted on the device running Orca — open Settings → Artifacts there to change it. Shown read-only here so it matches what that device enforces.'
              )
            : translate(
                'auto.components.settings.artifacts.allowPublishingDescription',
                'Off by default. When on, anything running on this device — your agents and the orca CLI — can upload HTML and Markdown files to your Orca account and mint links anyone with the URL can open. Turning it off does not delete existing links — remove those from Artifacts.'
              )
        }
        checked={sharingEnabled}
        disabled={isWebClient}
        onChange={() => void updateSettings({ artifactSharingEnabled: !sharingEnabled })}
      />
      <SettingsSwitchRow
        label={translate('auto.components.settings.artifacts.showButton', 'Show Artifacts Button')}
        description={translate(
          'auto.components.settings.artifacts.showButtonDescription',
          'Show the Artifacts shortcut in the sidebar.'
        )}
        checked={settings.showArtifactsButton === true}
        onChange={() => void updateSettings({ showArtifactsButton: !settings.showArtifactsButton })}
      />
      {!signedIn ? (
        <section className="flex flex-wrap items-center gap-4 py-5">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">
              {translate(
                'auto.components.settings.artifacts.signInTitle',
                'Sign in to share artifacts'
              )}
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.settings.artifacts.signInDescription',
                'Use your Orca account to upload artifacts and manage their public links.'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={connecting || authStatus?.configured !== true}
            onClick={() => void connect()}
          >
            {connecting
              ? translate('auto.components.settings.artifacts.signingIn', 'Signing in…')
              : authStatus?.state === 'reconnect-required'
                ? translate('auto.components.settings.artifacts.signInAgain', 'Sign in again')
                : translate('auto.components.settings.artifacts.signIn', 'Sign in to Orca')}
          </Button>
        </section>
      ) : null}
      <section className="space-y-4 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate('auto.components.settings.artifacts.howToTitle', 'How to use Artifacts')}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {sharingEnabled
              ? translate(
                  'auto.components.settings.artifacts.howToDescription',
                  'Ask your agent to share an HTML or Markdown file. Orca handles the upload with your account.'
                )
              : translate(
                  'auto.components.settings.artifacts.howToDescriptionDisabled',
                  'Publishing is off, so nothing on this device can create a public link yet. Allow it first, then ask your agent to share an HTML or Markdown file.'
                )}
          </p>
        </div>

        <ol className="space-y-3">
          {howToSteps.map((step, index) => (
            <li key={step.key} className="flex items-start gap-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-medium">{step.title}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{step.description}</p>
              </div>
            </li>
          ))}
        </ol>

        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start whitespace-normal rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-left hover:bg-muted/35 hover:text-foreground"
          onClick={openArtifactsPage}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <Files className="size-4" />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium text-foreground">
              {translate('auto.components.settings.artifacts.openArtifacts', 'Open Artifacts')}
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              {translate(
                'auto.components.settings.artifacts.openArtifactsDescriptionV2',
                'Preview, copy, and manage links shared through your account.'
              )}
            </span>
          </span>
          <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </Button>
      </section>
    </div>
  )
}
