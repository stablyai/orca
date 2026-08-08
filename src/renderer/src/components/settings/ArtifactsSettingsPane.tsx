import { useEffect } from 'react'
import { ArrowRight, Files } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { SettingsSwitchRow } from './SettingsFormControls'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

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

  useEffect(() => {
    if (!authStatus) {
      void fetchAuthStatus()
    }
  }, [authStatus, fetchAuthStatus])

  return (
    <div className="divide-y divide-border">
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
            {translate(
              'auto.components.settings.artifacts.howToDescription',
              'Ask your agent to share an HTML or Markdown file. Orca handles the upload with your account.'
            )}
          </p>
        </div>

        <ol className="space-y-3">
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              1
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.artifacts.shareStepTitle',
                  'Ask your agent to share it'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.artifacts.shareStepDescription',
                  'For example: “Share this HTML mock as an artifact.”'
                )}
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              2
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.artifacts.linkStepTitle',
                  'Share the public link'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.artifacts.linkStepDescription',
                  'Your agent returns a link that anyone with the URL can view.'
                )}
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              3
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.artifacts.manageStepTitle',
                  'Manage it in Orca'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.artifacts.manageStepDescription',
                  'Open Artifacts from the sidebar to revisit or delete links owned by your account.'
                )}
              </p>
            </div>
          </li>
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
