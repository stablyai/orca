// Settings › Enterprise: the directory sync (SCIM) group. Rendered only when auth's answer says
// `scim.available` (EnterpriseSsoView decides); nothing in the desktop turns it on.
import { ExternalLink, Users } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import { Badge } from '@/components/ui/badge'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  OrcaOrgEnterprise,
  OrcaOrgScimStatus
} from '../../../../../../shared/orca-org-enterprise'
import { formatRelativeFromNow } from '../../cloud-api/cloud-api-format'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { GroupTitle, Row } from './enterprise-sso-parts'

function scimStatusCopy(status: OrcaOrgScimStatus, t: Translate): { badge: string; body: string } {
  switch (status) {
    case 'active':
      return {
        badge: t('settings.enterprise.scim.status.active', 'Active'),
        body: t(
          'settings.enterprise.scim.status.activeBody',
          'Your identity provider adds, updates and removes teammates.'
        )
      }
    case 'waiting':
      return {
        badge: t('settings.enterprise.scim.status.waiting', 'Waiting for first sync'),
        body: t(
          'settings.enterprise.scim.status.waitingBody',
          'Directory sync is on. Nothing has arrived from your identity provider yet.'
        )
      }
    case 'not_enabled':
      return {
        badge: t('settings.enterprise.scim.status.notEnabled', 'Not turned on'),
        body: t(
          'settings.enterprise.scim.status.notEnabledBody',
          'Ask us to turn directory sync on for your team. Then connect your identity provider here.'
        )
      }
    case 'needs_sso':
    case 'unavailable':
      return {
        badge: t('settings.enterprise.scim.status.needsSso', 'Needs SSO'),
        body: t(
          'settings.enterprise.scim.status.needsSsoBody',
          'Turn on single sign-on first. Directory sync uses the same identity provider.'
        )
      }
  }
}

/** What the last change from the directory was, in words; null for a kind this build does not know. */
export function directoryChangeLabel(type: string | null, t: Translate): string | null {
  if (type === null) {
    return null
  }
  switch (type) {
    case 'user.added_to_org':
      return t('settings.enterprise.scim.change.added', 'A teammate was added')
    case 'user.removed_from_org':
      return t('settings.enterprise.scim.change.removed', 'A teammate was removed')
    case 'user.role_changed_within_org':
      return t('settings.enterprise.scim.change.role', 'A role changed')
    case 'org.scim_group_created':
    case 'org.scim_group_updated':
    case 'org.scim_group_deleted':
    case 'user.added_to_scim_group':
    case 'user.removed_from_scim_group':
      return t('settings.enterprise.scim.change.group', 'A group changed')
    default:
      return null
  }
}

export type EnterpriseDirectorySyncProps = {
  enterprise: OrcaOrgEnterprise
  now: number
  onOpenUrl: (url: string) => void
}

export function EnterpriseDirectorySync(props: EnterpriseDirectorySyncProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { scim, canManage } = props.enterprise
  const status = scimStatusCopy(scim.status, t)
  const setupUrl = scim.setupUrl
  const change = directoryChangeLabel(scim.lastChangeType, t)
  return (
    <SettingsGroup
      title={
        <GroupTitle icon={Users}>
          {t('settings.enterprise.scim.title', 'Directory sync')}
        </GroupTitle>
      }
    >
      <Row
        title={
          <>
            {t('settings.enterprise.scim.connection', 'SCIM provisioning')}
            <Badge variant={scim.status === 'active' ? 'statusSuccess' : 'tag'}>
              {status.badge}
            </Badge>
          </>
        }
        body={status.body}
      >
        {canManage && setupUrl && scim.status !== 'not_enabled' ? (
          <OpenExternalSplitButton
            variant="outline"
            size="sm"
            link={setupUrl}
            onClick={() => props.onOpenUrl(setupUrl)}
          >
            {t('settings.enterprise.scim.open', 'Open directory sync setup')}
            <ExternalLink />
          </OpenExternalSplitButton>
        ) : null}
      </Row>
      {canManage && setupUrl && scim.status !== 'not_enabled' ? (
        <p data-settings-row="" className="py-3 text-xs text-muted-foreground text-pretty">
          {t(
            'settings.enterprise.scim.keyNote',
            'The setup page shows the SCIM address and key to enter in your identity provider. Orca never shows or stores the key.'
          )}
        </p>
      ) : null}
      {scim.lastChangeAt !== null ? (
        <Row
          title={t('settings.enterprise.scim.lastChange', 'Last change received')}
          body={
            change
              ? t('settings.enterprise.scim.lastChangeSummary', '{{what}} · {{when}}', {
                  when: formatRelativeFromNow(scim.lastChangeAt, props.now, locale),
                  what: change
                })
              : formatRelativeFromNow(scim.lastChangeAt, props.now, locale)
          }
        />
      ) : null}
    </SettingsGroup>
  )
}
