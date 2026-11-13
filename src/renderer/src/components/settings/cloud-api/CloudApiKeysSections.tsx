import { useState } from 'react'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudApiSettings } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CopyValueButton } from './cloud-api-parts'
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
  onToggle,
  blocked = false
}: {
  /** The page shows one load error; this section stays quiet instead of repeating it. */
  blocked?: boolean
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
          {settings.status === 'error' && !blocked ? (
            <InlineError tone="neutral" title={settings.message} className="mt-2" />
          ) : null}
          {error ? <InlineError title={error} className="mt-2" /> : null}
        </div>
        {settings.status === 'loading' ? (
          <Skeleton className="mt-0.5 h-5 w-9 shrink-0" />
        ) : (
          <Switch
            className="mt-0.5"
            checked={pending ?? current}
            disabled={!canEdit}
            aria-disabled={pending !== null}
            aria-busy={pending !== null}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            onCheckedChange={(next) => (pending !== null ? undefined : void toggle(next))}
          />
        )}
      </div>
    </SettingsGroup>
  )
}
