import { useEffect } from 'react'
import { ArrowRight, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { SettingsSwitchRow } from './SettingsFormControls'

type HowToStep = { key: string; title: string; description: string }

export function ShareSkillsSettingsPane(): React.JSX.Element {
  const openSkillsPage = useAppStore((state) => state.openSkillsPage)
  const openSkillsSharedLinks = useAppStore((state) => state.openSkillsSharedLinks)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const authStatus = useAppStore((state) => state.orcaProfileAuthStatus)
  const connecting = useAppStore((state) => state.orcaProfileConnecting)
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const fetchAuthStatus = useAppStore((state) => state.fetchOrcaProfileAuthStatus)
  const signedIn = authStatus?.state === 'connected'
  const isWebClient = isWebClientLocation()
  const agentSharingEnabled = settings?.agentSkillSharingEnabled === true

  useEffect(() => {
    if (!authStatus) {
      void fetchAuthStatus()
    }
  }, [authStatus, fetchAuthStatus])

  const steps: HowToStep[] = [
    {
      key: 'select',
      title: translate(
        'auto.components.settings.shareSkills.selectTitle',
        'Select one or more skills'
      ),
      description: translate(
        'auto.components.settings.shareSkills.selectDescription',
        'Open Skills, choose Share skills, and select the skills to bundle behind one link.'
      )
    },
    {
      key: 'review',
      title: translate('auto.components.settings.shareSkills.reviewTitle', 'Review and publish'),
      description: translate(
        'auto.components.settings.shareSkills.reviewDescription',
        'Review included files, scripts, and executables before uploading the immutable bundle.'
      )
    },
    {
      key: 'share',
      title: translate('auto.components.settings.shareSkills.copyTitle', 'Copy the unlisted link'),
      description: translate(
        'auto.components.settings.shareSkills.copyDescription',
        'Anyone with the link can inspect and install all or selected skills without signing in.'
      )
    },
    {
      key: 'manage',
      title: translate(
        'auto.components.settings.shareSkills.manageTitle',
        'Manage or revoke links'
      ),
      description: translate(
        'auto.components.settings.shareSkills.manageDescription',
        'Revoking blocks future access. Skills already installed on another machine remain there.'
      )
    }
  ]

  return (
    <div className="divide-y divide-border">
      <section className="space-y-2 py-5 first:pt-0">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.shareSkills.linkTitle', 'Unlisted skill links')}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.settings.shareSkills.linkDescription',
            'Shared bundles are not searchable or listed in Orca. The link is the credential, so send it only to people you trust.'
          )}
        </p>
      </section>

      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.shareSkills.allowAgentPublishing',
          'Allow agents and the Orca CLI to publish skill links'
        )}
        description={
          isWebClient
            ? translate(
                'auto.components.settings.shareSkills.allowAgentPublishingWebDescription',
                'Desktop only. Open Settings → Share Skills on the host device to change this setting.'
              )
            : translate(
                'auto.components.settings.shareSkills.allowAgentPublishingDescription',
                'Let commands publish explicitly named installed skills. Skill folders can contain scripts, configuration, or secrets, so this is off by default.'
              )
        }
        checked={agentSharingEnabled}
        disabled={isWebClient}
        onChange={() => void updateSettings({ agentSkillSharingEnabled: !agentSharingEnabled })}
      />

      {!isWebClient ? (
        <SettingsSwitchRow
          label={translate('auto.components.settings.shareSkills.showButton', 'Show Skills Button')}
          description={translate(
            'auto.components.settings.shareSkills.showButtonDescription',
            'Show the Skills shortcut in the sidebar.'
          )}
          checked={settings?.showSkillsButton === true}
          onChange={() => void updateSettings({ showSkillsButton: !settings?.showSkillsButton })}
        />
      ) : null}

      {!signedIn ? (
        <section className="flex flex-wrap items-center gap-4 py-5">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">
              {translate(
                'auto.components.settings.shareSkills.signInTitle',
                'Sign in to share skills'
              )}
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {isWebClient
                ? translate(
                    'auto.components.settings.shareSkills.signInWebDescription',
                    'Publishing and link management are available in the Orca desktop app.'
                  )
                : translate(
                    'auto.components.settings.shareSkills.signInDescription',
                    'Use your Orca account to publish bundles and manage their links. Recipients do not need an account.'
                  )}
            </p>
          </div>
          {!isWebClient ? (
            <Button
              type="button"
              size="sm"
              disabled={connecting || authStatus?.configured !== true}
              onClick={() => void connect()}
            >
              {connecting
                ? translate('auto.components.settings.shareSkills.signingIn', 'Signing in…')
                : authStatus?.state === 'reconnect-required'
                  ? translate('auto.components.settings.shareSkills.signInAgain', 'Sign in again')
                  : translate('auto.components.settings.shareSkills.signIn', 'Sign in to Orca')}
            </Button>
          ) : null}
        </section>
      ) : null}

      {/* Why: the link inventory grows without bound and belongs with the page
          that publishes it; settings keeps the preference and the way over. */}
      {signedIn && !isWebClient ? (
        <section className="flex flex-wrap items-center gap-4 py-5">
          <div className="min-w-0 flex-1 space-y-1">
            <h3 className="text-sm font-medium">
              {translate('auto.components.settings.shareSkills.activeLinks', 'Active shared links')}
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {translate(
                'auto.components.settings.shareSkills.activeLinksDescription',
                'Only people with a link can open it. Unshare a link to block future inspection and installs.'
              )}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={openSkillsSharedLinks}>
            {translate('auto.components.settings.shareSkills.manageInSkills', 'Manage in Skills')}
            <ArrowRight className="size-3.5" />
          </Button>
        </section>
      ) : null}

      <section className="space-y-4 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate('auto.components.settings.shareSkills.howToTitle', 'How to share skills')}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.shareSkills.howToDescription',
              'Publish one skill or a bundle such as a collection of 30 skills behind one link.'
            )}
          </p>
        </div>

        <ol className="space-y-3">
          {steps.map((step, index) => (
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

        {!isWebClient ? (
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start whitespace-normal rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-left hover:bg-muted/35 hover:text-foreground"
            onClick={openSkillsPage}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
              <BookOpen className="size-4" />
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block text-sm font-medium text-foreground">
                {translate('auto.components.settings.shareSkills.openSkills', 'Open Skills')}
              </span>
              <span className="block text-xs font-normal text-muted-foreground">
                {translate(
                  'auto.components.settings.shareSkills.openSkillsDescription',
                  'Publish a bundle, install from a link, or manage installed and shared skills.'
                )}
              </span>
            </span>
            <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
          </Button>
        ) : null}
      </section>
    </div>
  )
}
