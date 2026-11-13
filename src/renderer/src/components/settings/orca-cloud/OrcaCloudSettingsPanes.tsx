import { Fragment } from 'react'
import { CircleUserRound } from 'lucide-react'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useOrcaProfileAuthStatusRefresh } from '@/hooks/use-orca-profile-auth-status-refresh'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { TeamPageBody } from '../../billing/team/TeamDialogHost'
import {
  CloudEnvironmentSection,
  useOrcaCloudEnvironmentsAvailability
} from '../../cloud-environment/CloudEnvironmentSection'
import { OrcaSignInButton, OrcaSignInWaitNotice } from '../../OrcaSignInProgress'
import { CloudApiEmptyState } from '../cloud-api/cloud-api-parts'
import { EnterpriseSettingsPane } from '../enterprise/EnterpriseSettingsPane'
import { CloudSecretsSection } from '../cloud-secrets/CloudSecretsSection'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudPredictiveWakeSetting } from './CloudPredictiveWakeSetting'
import { OrcaCloudMcpServersPane } from './OrcaCloudMcpServersPane'
import { OrcaCloudLocalCommandsPane } from './OrcaCloudLocalCommandsPane'
import { OrcaCloudSkillsPane } from './cloud-skills/OrcaCloudSkillsPane'

type OrcaCloudAccount = {
  orgId: string | null
  orgName: string | null
  userId: string | null
  billing: boolean
  sandbox: boolean
}

export function OrcaCloudSignedOutNotice(): React.JSX.Element {
  const t = useTranslate()
  const reconnect = useAppStore((s) => s.orcaProfileAuthStatus?.state === 'reconnect-required')
  return (
    <SettingsGroup>
      <CloudApiEmptyState
        icon={CircleUserRound}
        title={
          reconnect
            ? t('settings.orcaCloud.signedOut.reconnectTitle', 'Sign in again')
            : t('auto.components.settings.cloudApi.signedOut.title', 'Sign in to Orca')
        }
        description={
          reconnect
            ? t(
                'auto.components.settings.orcaAccount.reconnectRequired',
                'Your session expired. Sign in again to use Orca Cloud.'
              )
            : t(
                'settings.orcaCloud.signedOut.body',
                'Orca Cloud settings belong to your Orca account. Sign in to manage them.'
              )
        }
        action={
          <div className="flex flex-col items-center gap-2">
            <OrcaSignInButton size="sm">
              {reconnect
                ? t('auto.components.settings.orcaAccount.signInAgain', 'Sign in again')
                : t('auto.components.settings.orcaAccount.signIn', 'Sign in to Orca')}
            </OrcaSignInButton>
            <OrcaSignInWaitNotice />
          </div>
        }
      />
    </SettingsGroup>
  )
}

/** Every Orca Cloud pane needs the account: show sign-in instead of an empty or failing pane. */
function OrcaCloudAccountGate({
  children
}: {
  children: (account: OrcaCloudAccount) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  // Team-scoped panes remount on a team switch so none of them shows the previous team's data.
  const accountKey = useOrcaAccountKey()
  useOrcaProfileAuthStatusRefresh()
  if (!authStatus) {
    return (
      <div className="space-y-3" aria-busy>
        <span className="sr-only">
          {t('auto.components.settings.orcaAccount.checking', 'Checking account status…')}
        </span>
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (authStatus.state !== 'connected') {
    return <OrcaCloudSignedOutNotice />
  }
  return (
    <Fragment key={accountKey}>
      {children({
        orgId: authStatus.cloud?.activeOrgId ?? null,
        orgName: authStatus.cloud?.activeOrgName ?? null,
        userId: authStatus.cloud?.userId ?? null,
        billing: authStatus.capabilities?.flags?.billing === true,
        sandbox: authStatus.capabilities?.flags?.sandbox === true
      })}
    </Fragment>
  )
}

/** Settings › Enterprise: single sign-on, sign-in policies and the team audit log. */
export function OrcaCloudEnterprisePane(): React.JSX.Element {
  return <OrcaCloudAccountGate>{() => <EnterpriseSettingsPane />}</OrcaCloudAccountGate>
}

export function OrcaCloudTeamPane(): React.JSX.Element {
  const t = useTranslate()
  return (
    <OrcaCloudAccountGate>
      {(account) =>
        account.billing ? (
          // JA-17: members inline (invite field, then the table); seats and invoices stay on
          // Plan & billing, linked. Remount per team so row state never carries over.
          <TeamPageBody
            key={account.orgId ?? 'none'}
            arrival={null}
            inline={{
              onOpenPlanBilling: () => {
                const store = useAppStore.getState()
                store.openSettingsTarget({ pane: 'cloud-billing', repoId: null })
                store.openSettingsPage()
              }
            }}
          />
        ) : (
          <InlineError
            tone="neutral"
            title={t(
              'settings.orcaCloud.team.unavailable',
              'Teams aren’t available for this account yet.'
            )}
          />
        )
      }
    </OrcaCloudAccountGate>
  )
}

export function OrcaCloudSecretsPane(): React.JSX.Element {
  return (
    <OrcaCloudAccountGate>
      {(account) => <CloudSecretsSection orgId={account.orgId} />}
    </OrcaCloudAccountGate>
  )
}

export function OrcaCloudEnvironmentsPane(): React.JSX.Element {
  const t = useTranslate()
  const configured = useOrcaCloudEnvironmentsAvailability()
  return (
    <OrcaCloudAccountGate>
      {(account) => (
        <div className="space-y-8">
          {configured === null ? (
            <Skeleton className="h-24 w-full" />
          ) : configured ? (
            <CloudEnvironmentSection orgId={account.orgId} viewerUserId={account.userId} />
          ) : (
            <InlineError
              tone="neutral"
              title={t(
                'settings.orcaCloud.environments.unavailable',
                'Cloud environments aren’t available for this account yet.'
              )}
            />
          )}
          {account.sandbox ? <CloudPredictiveWakeSetting /> : null}
        </div>
      )}
    </OrcaCloudAccountGate>
  )
}

export function OrcaCloudMcpPane(): React.JSX.Element {
  return <OrcaCloudAccountGate>{() => <OrcaCloudMcpServersPane />}</OrcaCloudAccountGate>
}

export function OrcaCloudLocalCommandsSettingsPane(): React.JSX.Element {
  return <OrcaCloudAccountGate>{() => <OrcaCloudLocalCommandsPane />}</OrcaCloudAccountGate>
}

export function OrcaCloudSkillsSyncPane(): React.JSX.Element {
  return <OrcaCloudAccountGate>{() => <OrcaCloudSkillsPane />}</OrcaCloudAccountGate>
}
