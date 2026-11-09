import { useState } from 'react'
import { ExternalLink, History, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  CloudApiAuditEntry,
  CloudApiAuditPage,
  CloudApiMe,
  CloudApiSettings
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { formatAbsoluteTime, formatRelativeFromNow } from './cloud-api-format'
import { CloudApiErrorNotice, CloudApiSkeletonRows, CopyValueButton } from './cloud-api-parts'
import type { CloudLoadState } from './cloud-load-state'

function LinkRow({
  label,
  description,
  url,
  copyLabel,
  openLabel,
  extra
}: {
  label: string
  description: string
  url: string
  copyLabel: string
  openLabel?: string
  extra?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-settings-row="" className="flex items-center gap-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        <code className="block truncate font-mono text-xs text-foreground/80" title={url}>
          {url}
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {extra}
        {openLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void window.api.shell.openUrl(url)}
            aria-label={openLabel}
          >
            <ExternalLink />
            {openLabel}
          </Button>
        ) : null}
        <CopyValueButton value={url} label={copyLabel} />
      </div>
    </div>
  )
}

export function AccessLinks({
  controlPlaneUrl,
  onApprove
}: {
  controlPlaneUrl: string
  onApprove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const base = controlPlaneUrl.replace(/\/+$/, '')
  return (
    <SettingsGroup
      title={t('auto.components.settings.cloudApi.links.title', 'Connect')}
      description={t(
        'auto.components.settings.cloudApi.links.description',
        'Point scripts and AI tools at Orca Cloud. Requests authenticate with an API key as a Bearer token.'
      )}
    >
      <LinkRow
        label={t('auto.components.settings.cloudApi.links.docs', 'API reference')}
        description={t(
          'auto.components.settings.cloudApi.links.docsBody',
          'Every endpoint, with request and response examples.'
        )}
        url={`${base}/docs`}
        copyLabel={t('auto.components.settings.cloudApi.links.copyDocs', 'Copy API reference URL')}
        openLabel={t('auto.components.settings.cloudApi.links.open', 'Open')}
      />
      <LinkRow
        label={t('auto.components.settings.cloudApi.links.mcp', 'MCP server')}
        description={t(
          'auto.components.settings.cloudApi.links.mcpBody',
          'Add this URL to Claude, Cursor or any MCP client. When it asks you to approve, paste a one-time code from Approve app.'
        )}
        url={`${base}/mcp`}
        copyLabel={t('auto.components.settings.cloudApi.links.copyMcp', 'Copy MCP server URL')}
        extra={
          <Button type="button" variant="ghost" size="xs" onClick={onApprove}>
            <ShieldCheck />
            {t('auto.components.settings.cloudApi.links.approve', 'Approve app')}
          </Button>
        }
      />
    </SettingsGroup>
  )
}

export function OrgSettings({
  settings,
  onToggle
}: {
  settings: CloudLoadState<CloudApiSettings>
  onToggle: (enabled: boolean) => Promise<string | null>
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, setPending] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const labelId = 'cloud-api-vm-cli-label'
  const descriptionId = 'cloud-api-vm-cli-description'
  const current = settings.status === 'ok' ? settings.data.settings.vmCliEnabled : false
  const canEdit = settings.status === 'ok' && settings.data.canEdit
  const toggle = async (next: boolean): Promise<void> => {
    setPending(next)
    setError(null)
    const failure = await onToggle(next)
    setPending(null)
    setError(failure)
  }
  return (
    <SettingsGroup
      title={t('auto.components.settings.cloudApi.org.title', 'Agent access')}
      description={t(
        'auto.components.settings.cloudApi.org.description',
        'Applies to everyone on your team.'
      )}
    >
      <div data-settings-row="" className="flex items-start gap-4 py-3.5">
        <div className="min-w-0 flex-1 space-y-1">
          <p id={labelId} className="text-sm font-medium">
            {t(
              'auto.components.settings.cloudApi.org.vmCli',
              'Let agents in cloud workspaces create workspaces'
            )}
          </p>
          <p id={descriptionId} className="text-xs leading-5 text-muted-foreground">
            {t(
              'auto.components.settings.cloudApi.org.vmCliBody',
              'Agents get a short-lived token for the orca CLI inside their sandbox, so they can start sibling workspaces and hand work to other agents. Turning this off revokes every outstanding token at once.'
            )}
            {settings.status === 'ok' && !canEdit ? (
              <span className="mt-1 block">
                {t(
                  'auto.components.settings.cloudApi.org.adminOnly',
                  'Only team owners and admins can change this.'
                )}
              </span>
            ) : null}
          </p>
          {settings.status === 'error' ? (
            <p className="text-xs text-destructive">{settings.message}</p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        {settings.status === 'loading' ? (
          <Skeleton className="mt-0.5 h-5 w-9 shrink-0" />
        ) : (
          <Switch
            className="mt-0.5"
            checked={pending ?? current}
            disabled={!canEdit || pending !== null}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            onCheckedChange={(next) => void toggle(next)}
          />
        )}
      </div>
    </SettingsGroup>
  )
}

const AUDIT_ACTIONS: Record<string, [key: string, fallback: string]> = {
  'api_key.create': ['auto.components.settings.cloudApi.audit.action.keyCreate', 'Created API key'],
  'api_key.revoke': ['auto.components.settings.cloudApi.audit.action.keyRevoke', 'Revoked API key'],
  'settings.update': [
    'auto.components.settings.cloudApi.audit.action.settings',
    'Changed agent access'
  ],
  'workspace.create': [
    'auto.components.settings.cloudApi.audit.action.wsCreate',
    'Started a workspace'
  ],
  'workspace.destroy': [
    'auto.components.settings.cloudApi.audit.action.wsDestroy',
    'Deleted a workspace'
  ],
  'workspace.sleep': [
    'auto.components.settings.cloudApi.audit.action.wsSleep',
    'Put a workspace to sleep'
  ],
  'workspace.wake': ['auto.components.settings.cloudApi.audit.action.wsWake', 'Woke a workspace'],
  'workspace.archive': [
    'auto.components.settings.cloudApi.audit.action.wsArchive',
    'Archived a workspace'
  ],
  'workspace.message': [
    'auto.components.settings.cloudApi.audit.action.wsMessage',
    'Messaged an agent'
  ],
  'project.create': [
    'auto.components.settings.cloudApi.audit.action.projectCreate',
    'Created a project'
  ],
  'project.update': [
    'auto.components.settings.cloudApi.audit.action.projectUpdate',
    'Edited a project'
  ],
  'project.delete': [
    'auto.components.settings.cloudApi.audit.action.projectDelete',
    'Deleted a project'
  ],
  'mcp.approval_create': [
    'auto.components.settings.cloudApi.audit.action.approval',
    'Made an app approval code'
  ]
}

/** "Created API key “CI deploy”"; unknown actions fall back to their machine name. */
function auditActionLabel(entry: CloudApiAuditEntry, t: Translate): string {
  const known = AUDIT_ACTIONS[entry.action]
  const base = known ? t(known[0], known[1]) : entry.action
  const name = entry.detail?.name
  return typeof name === 'string' && name.length > 0 ? `${base} “${name.slice(0, 80)}”` : base
}

function actorLabel(entry: CloudApiAuditEntry, viewer: CloudApiMe | null, t: Translate): string {
  const who =
    entry.actor.userId && entry.actor.userId === viewer?.userId
      ? t('auto.components.settings.cloudApi.audit.you', 'You')
      : t('auto.components.settings.cloudApi.audit.teammate', 'A teammate')
  if (entry.actor.type === 'api_key') {
    return t('auto.components.settings.cloudApi.audit.viaKey', '{{value0}} via API key', {
      value0: who
    })
  }
  if (entry.actor.type === 'mcp') {
    return t('auto.components.settings.cloudApi.audit.viaMcp', '{{value0}} via MCP', {
      value0: who
    })
  }
  if (entry.actor.type === 'workspace_token') {
    return t('auto.components.settings.cloudApi.audit.viaAgent', 'Agent in a cloud workspace')
  }
  return who
}

export function AuditLog({
  audit,
  now,
  viewer,
  initiallyOpen,
  onLoad
}: {
  audit: CloudLoadState<CloudApiAuditPage>
  now: number
  viewer: CloudApiMe | null
  initiallyOpen: boolean
  onLoad: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <SettingsGroup
      title={t('auto.components.settings.cloudApi.audit.title', 'Recent activity')}
      description={t(
        'auto.components.settings.cloudApi.audit.description',
        'Key, workspace and settings changes across the account. Visible to admins only.'
      )}
      action={
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={open}
          aria-controls="cloud-api-activity"
          onClick={() => {
            if (!open) {
              onLoad()
            }
            setOpen(!open)
          }}
        >
          <History />
          {open
            ? t('auto.components.settings.cloudApi.audit.hide', 'Hide')
            : t('auto.components.settings.cloudApi.audit.show', 'Show activity')}
        </Button>
      }
      bodyClassName={open ? undefined : 'hidden'}
    >
      {!open ? null : audit.status === 'loading' ? (
        <CloudApiSkeletonRows
          rows={2}
          label={t('auto.components.settings.cloudApi.audit.loading', 'Loading activity')}
        />
      ) : audit.status === 'error' ? (
        <div data-settings-row="" className="py-4">
          <CloudApiErrorNotice message={audit.message} onRetry={onLoad} />
        </div>
      ) : audit.data.entries.length === 0 ? (
        <p data-settings-row="" className="py-4 text-xs text-muted-foreground">
          {t('auto.components.settings.cloudApi.audit.empty', 'Nothing has happened yet.')}
        </p>
      ) : (
        <ul id="cloud-api-activity">
          {audit.data.entries.slice(0, 25).map((entry) => (
            <li
              key={entry.id}
              data-settings-row=""
              className="flex items-center gap-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground" title={entry.action}>
                {auditActionLabel(entry, t)}
              </span>
              <span className="w-44 shrink-0 truncate text-muted-foreground">
                {actorLabel(entry, viewer, t)}
              </span>
              <span
                className="shrink-0 text-muted-foreground"
                title={formatAbsoluteTime(entry.createdAt, locale)}
              >
                {formatRelativeFromNow(entry.createdAt, now, locale)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  )
}
