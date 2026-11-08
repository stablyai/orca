import { ArrowRight, Files } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { Button } from '@/components/ui/button'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useTranslate } from '@/i18n/use-translate'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../../OrcaSignInProgress'

type HowToStep = { key: string; title: string; description: string }

export function ArtifactsSettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const openArtifactsPage = useAppStore((state) => state.openArtifactsPage)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const signedIn = authStatus?.state === 'connected'
  // Only the desktop host can grant sharing; web clients mirror it because settings.update excludes this capability.
  const isWebClient = isWebClientLocation()
  const sharingEnabled = settings.artifactSharingEnabled === true

  useOrcaProfileAuthStatusRefresh()

  const howToSteps: HowToStep[] = [
    ...(sharingEnabled
      ? []
      : [
          {
            key: 'enable',
            title: t(
              'auto.components.settings.artifacts.enableStepTitle',
              'Enable artifact sharing'
            ),
            description: isWebClient
              ? t(
                  'auto.components.settings.artifacts.enableStepWebDescription',
                  'Open Settings → Artifacts in the Orca desktop app on the host device and enable publishing.'
                )
              : t(
                  'auto.components.settings.artifacts.enableStepDescription',
                  'Turn on “Allow publishing public artifact links” above.'
                )
          }
        ]),
    {
      key: 'share',
      title: t('auto.components.settings.artifacts.shareStepTitle', 'Choose a file to share'),
      description: t(
        'auto.components.settings.artifacts.shareStepDescription',
        'Open an HTML or Markdown file and select Share as artifact, or ask an agent to share it.'
      )
    },
    {
      key: 'link',
      title: t('auto.components.settings.artifacts.linkStepTitle', 'Copy the public link'),
      description: t(
        'auto.components.settings.artifacts.linkStepDescription',
        'After publishing, copy the link and send it to your team.'
      )
    },
    {
      key: 'manage',
      title: t('auto.components.settings.artifacts.manageStepTitle', 'Manage it in Orca'),
      description: t(
        'auto.components.settings.artifacts.manageStepDescription',
        'Open Artifacts from the sidebar to preview or remove links.'
      )
    }
  ]

  return (
    <div className="space-y-8">
      <SettingsGroup>
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.artifacts.allowPublishing',
            'Allow publishing public artifact links'
          )}
          description={
            isWebClient
              ? t(
                  'auto.components.settings.artifacts.allowPublishingWebDescription',
                  'Desktop only. Open Settings → Artifacts on the host device to change this setting.'
                )
              : t(
                  'auto.components.settings.artifacts.allowPublishingDescription',
                  'Publish HTML and Markdown files as links anyone with the URL can open. Existing links remain until you delete them from Artifacts.'
                )
          }
          checked={sharingEnabled}
          disabled={isWebClient}
          onChange={() => void updateSettings({ artifactSharingEnabled: !sharingEnabled })}
        />
        <SettingsSwitchRow
          label={t('auto.components.settings.artifacts.showButton', 'Show Artifacts Button')}
          description={t(
            'auto.components.settings.artifacts.showButtonDescription',
            'Show the Artifacts shortcut in the sidebar.'
          )}
          checked={settings.showArtifactsButton === true}
          onChange={() =>
            void updateSettings({ showArtifactsButton: !settings.showArtifactsButton })
          }
        />
        {!signedIn ? (
          <section data-settings-row="" className="flex flex-wrap items-center gap-4 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-sm font-medium">
                {t('auto.components.settings.artifacts.signInTitle', 'Sign in to share artifacts')}
              </h3>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  'auto.components.settings.artifacts.signInDescription',
                  'Use your Orca account to upload artifacts and manage their public links.'
                )}
              </p>
            </div>
            <OrcaSignInButton size="sm" disabled={authStatus?.configured !== true}>
              {authStatus?.state === 'reconnect-required'
                ? t('auto.components.settings.artifacts.signInAgain', 'Sign in again')
                : t('auto.components.settings.artifacts.signIn', 'Sign in to Orca')}
            </OrcaSignInButton>
            <OrcaSignInWaitNotice className="basis-full" />
          </section>
        ) : null}
      </SettingsGroup>
      <SettingsGroup
        title={t('auto.components.settings.artifacts.howToTitle', 'How to use Artifacts')}
        description={
          sharingEnabled
            ? t(
                'auto.components.settings.artifacts.howToDescription',
                'Publish HTML or Markdown files as public links, then share them with your team.'
              )
            : t(
                'auto.components.settings.artifacts.howToDescriptionDisabled',
                'Enable artifact sharing above to publish HTML or Markdown files as public links.'
              )
        }
        bodyClassName="py-4"
      >
        <div className="space-y-4">
          <ol className="space-y-3">
            {howToSteps.map((step, index) => (
              <li key={step.key} className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {step.description}
                  </p>
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
                {t('auto.components.settings.artifacts.openArtifacts', 'Open Artifacts')}
              </span>
              <span className="block text-xs font-normal text-muted-foreground">
                {t(
                  'auto.components.settings.artifacts.openArtifactsDescriptionV2',
                  'Preview, copy, and manage links shared through your account.'
                )}
              </span>
            </span>
            <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </Button>
        </div>
      </SettingsGroup>
    </div>
  )
}
