import { useState } from 'react'
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  CloudApiApproval,
  CloudApiAuditPage,
  CloudApiCreatedKey,
  CloudApiGrant,
  CloudApiKey,
  CloudApiKeyList,
  CloudApiMe,
  CloudApiResult,
  CloudApiSettings,
  CreateCloudApiApprovalInput,
  CreateCloudApiKeyInput
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { ApproveAppDialog } from './ApproveAppDialog'
import { AccessLinks, AuditLog, OrgSettings } from './CloudApiKeysSections'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import { CloudConnectedApps } from './CloudConnectedApps'
import type { CloudLoadState } from './cloud-load-state'
import { CreateApiKeyDialog } from './CreateApiKeyDialog'
import { formatAbsoluteTime, formatKeyPrefix, formatRelativeFromNow } from './cloud-api-format'
import {
  CloudApiEmptyState,
  CloudApiErrorNotice,
  CloudApiSkeletonRows,
  ScopeChip
} from './cloud-api-parts'

const EXPIRY_WARNING_MS = 7 * 86_400_000

export type CloudApiKeysViewProps = {
  controlPlaneUrl: string
  viewer: CloudApiMe | null
  keys: CloudLoadState<CloudApiKeyList>
  settings: CloudLoadState<CloudApiSettings>
  /** Null hides the activity log (members cannot read it). */
  audit: CloudLoadState<CloudApiAuditPage> | null
  now: number
  onRefresh: () => void
  onCreate: (input: CreateCloudApiKeyInput) => Promise<CloudApiResult<CloudApiCreatedKey>>
  /** Resolves to an error message or null. */
  onRevoke: (key: CloudApiKey) => Promise<string | null>
  onToggleVmCli: (enabled: boolean) => Promise<string | null>
  onLoadAudit: () => void
  grants: CloudLoadState<CloudApiGrant[]>
  onRevokeGrant: (grant: CloudApiGrant) => Promise<string | null>
  onRefreshGrants: () => void
  onCreateApproval: (
    input: CreateCloudApiApprovalInput
  ) => Promise<CloudApiResult<CloudApiApproval>>
  /** Fixtures: start with a dialog open (and a pinned clock for countdowns). */
  initial?: {
    create?: boolean
    created?: CloudApiCreatedKey
    revokeKeyId?: string
    auditOpen?: boolean
    approve?: boolean
    approval?: CloudApiApproval
    revokeGrantId?: string
  }
}

function isAdmin(viewer: CloudApiMe | null): boolean {
  return viewer !== null && viewer.role !== 'member'
}

export function CloudApiKeysView(props: CloudApiKeysViewProps): React.JSX.Element {
  const t = useTranslate()
  const { keys, viewer, initial } = props
  const [createOpen, setCreateOpen] = useState(Boolean(initial?.create || initial?.created))
  // The target outlives the open flag so the title does not blank out during the close animation.
  const [revoking, setRevoking] = useState<CloudApiKey | null>(() =>
    initial?.revokeKeyId && keys.status === 'ok'
      ? (keys.data.keys.find((key) => key.id === initial.revokeKeyId) ?? null)
      : null
  )
  const [revokeOpen, setRevokeOpen] = useState(revoking !== null)
  const [approveOpen, setApproveOpen] = useState(Boolean(initial?.approve || initial?.approval))
  const available = keys.status === 'ok' ? keys.data.availableScopes : (viewer?.scopes ?? [])
  const orgAdmin = Boolean(viewer?.orgId) && isAdmin(viewer)

  const createButton = (
    <Button
      type="button"
      size="sm"
      onClick={() => setCreateOpen(true)}
      disabled={keys.status !== 'ok'}
    >
      <Plus />
      {t('auto.components.settings.cloudApi.keys.create', 'Create key')}
    </Button>
  )

  return (
    <div className="space-y-8">
      <SettingsGroup
        title={t('auto.components.settings.cloudApi.keys.listTitle', 'Keys')}
        description={
          viewer?.orgId
            ? orgAdmin
              ? t(
                  'auto.components.settings.cloudApi.keys.scopeAdmin',
                  'As an org admin you see every key in your org and can revoke any of them.'
                )
              : t(
                  'auto.components.settings.cloudApi.keys.scopeMember',
                  'You see the keys you created. Org admins can see every key in the org.'
                )
            : t(
                'auto.components.settings.cloudApi.keys.scopePersonal',
                'Use keys with the Orca Cloud API, the orca CLI and MCP clients.'
              )
        }
        action={
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={props.onRefresh}
              disabled={keys.status === 'loading'}
              aria-label={t('auto.components.settings.cloudApi.keys.refresh', 'Refresh API keys')}
            >
              <RefreshCw
                className={cn(
                  keys.status === 'loading' && 'animate-spin motion-reduce:animate-none'
                )}
              />
            </Button>
            {keys.status === 'ok' && keys.data.keys.length === 0 ? null : createButton}
          </div>
        }
      >
        {keys.status === 'loading' ? (
          <CloudApiSkeletonRows
            label={t('auto.components.settings.cloudApi.keys.loading', 'Loading API keys')}
          />
        ) : keys.status === 'error' ? (
          <div data-settings-row="" className="py-4">
            <CloudApiErrorNotice message={keys.message} onRetry={props.onRefresh} />
          </div>
        ) : keys.data.keys.length === 0 ? (
          <CloudApiEmptyState
            icon={KeyRound}
            title={t('auto.components.settings.cloudApi.keys.emptyTitle', 'No API keys yet')}
            description={t(
              'auto.components.settings.cloudApi.keys.emptyBody',
              'Create a key to start workspaces, message agents and run routines from scripts, CI or any MCP client.'
            )}
            action={createButton}
          />
        ) : (
          <ul aria-label={t('auto.components.settings.cloudApi.keys.listLabel', 'API keys')}>
            {keys.data.keys.map((key) => (
              <KeyRow
                key={key.id}
                apiKey={key}
                viewer={viewer}
                now={props.now}
                onRevoke={() => {
                  setRevoking(key)
                  setRevokeOpen(true)
                }}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      <AccessLinks controlPlaneUrl={props.controlPlaneUrl} onApprove={() => setApproveOpen(true)} />

      <CloudConnectedApps
        grants={props.grants}
        viewer={viewer}
        now={props.now}
        onApprove={() => setApproveOpen(true)}
        onRevoke={props.onRevokeGrant}
        onRetry={props.onRefreshGrants}
        initialRevokeId={initial?.revokeGrantId}
      />

      <OrgSettings settings={props.settings} onToggle={props.onToggleVmCli} />

      {props.audit ? (
        <AuditLog
          audit={props.audit}
          now={props.now}
          viewer={viewer}
          initiallyOpen={initial?.auditOpen ?? false}
          onLoad={props.onLoadAudit}
        />
      ) : null}

      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        availableScopes={available}
        onCreate={props.onCreate}
        initialCreated={initial?.created}
      />
      <ApproveAppDialog
        open={approveOpen}
        onOpenChange={setApproveOpen}
        availableScopes={available}
        onCreate={props.onCreateApproval}
        initialApproval={initial?.approval}
        nowForFixture={initial?.approval ? props.now : undefined}
      />
      <CloudConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={t('auto.components.settings.cloudApi.revoke.title', 'Revoke “{{value0}}”?', {
          value0: revoking?.name ?? ''
        })}
        description={
          <p>
            {t(
              'auto.components.settings.cloudApi.revoke.body',
              'Anything using {{value0}} stops working immediately. This cannot be undone.',
              { value0: revoking ? formatKeyPrefix(revoking.prefix) : '' }
            )}
          </p>
        }
        confirmLabel={t('auto.components.settings.cloudApi.revoke.confirm', 'Revoke key')}
        onConfirm={async () => (revoking ? props.onRevoke(revoking) : null)}
      />
    </div>
  )
}

function creatorLabel(key: CloudApiKey, viewer: CloudApiMe | null, t: Translate): string {
  return viewer?.userId === key.createdBy
    ? t('auto.components.settings.cloudApi.keys.createdByYou', 'you')
    : t('auto.components.settings.cloudApi.keys.createdByTeammate', 'a teammate')
}

function KeyRow({
  apiKey,
  viewer,
  now,
  onRevoke
}: {
  apiKey: CloudApiKey
  viewer: CloudApiMe | null
  now: number
  onRevoke: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const expiresSoon = apiKey.expiresAt !== null && apiKey.expiresAt - now < EXPIRY_WARNING_MS
  return (
    <li data-settings-row="" className="flex items-start gap-3 py-3.5">
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
        <KeyRound className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="truncate text-sm font-medium">{apiKey.name}</p>
          <code className="font-mono text-xs text-muted-foreground">
            {formatKeyPrefix(apiKey.prefix)}
          </code>
        </div>
        <div className="flex flex-wrap gap-1">
          {apiKey.scopes.map((scope) => (
            <ScopeChip key={scope} scope={scope} />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          <span title={formatAbsoluteTime(apiKey.createdAt, locale)}>
            {t(
              'auto.components.settings.cloudApi.keys.created',
              'Created by {{value0}} {{value1}}',
              {
                value0: creatorLabel(apiKey, viewer, t),
                value1: formatRelativeFromNow(apiKey.createdAt, now, locale)
              }
            )}
          </span>
          <span aria-hidden> · </span>
          <span
            title={apiKey.lastUsedAt ? formatAbsoluteTime(apiKey.lastUsedAt, locale) : undefined}
          >
            {apiKey.lastUsedAt
              ? t('auto.components.settings.cloudApi.keys.lastUsed', 'Last used {{value0}}', {
                  value0: formatRelativeFromNow(apiKey.lastUsedAt, now, locale)
                })
              : t('auto.components.settings.cloudApi.keys.neverUsed', 'Never used')}
          </span>
          {apiKey.expiresAt !== null ? (
            <>
              <span aria-hidden> · </span>
              <span
                className={cn(expiresSoon && 'text-status-warning-text')}
                title={formatAbsoluteTime(apiKey.expiresAt, locale)}
              >
                {apiKey.expiresAt <= now
                  ? t('auto.components.settings.cloudApi.keys.expired', 'Expired')
                  : t('auto.components.settings.cloudApi.keys.expires', 'Expires {{value0}}', {
                      value0: formatRelativeFromNow(apiKey.expiresAt, now, locale)
                    })}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onRevoke}
        aria-label={t('auto.components.settings.cloudApi.keys.revokeLabel', 'Revoke {{value0}}', {
          value0: apiKey.name
        })}
      >
        <Trash2 />
        {t('auto.components.settings.cloudApi.keys.revoke', 'Revoke')}
      </Button>
    </li>
  )
}
