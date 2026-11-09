import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { KeyRound, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
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
import { PersonSentence } from './PersonName'
import { ScopeSummary } from './ScopeSummary'
import { CloudApiEmptyState, CloudApiErrorNotice, CloudApiSkeletonRows } from './cloud-api-parts'

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
  /** A refresh is running while the current data stays on screen. */
  refreshing?: boolean
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
  const revokingApps =
    revoking && props.grants.status === 'ok'
      ? props.grants.data.filter(
          (grant) =>
            'apiKeyPrefix' in grant.approvedWith &&
            grant.approvedWith.apiKeyPrefix === revoking.prefix
        ).length
      : 0
  const [approveOpen, setApproveOpen] = useState(Boolean(initial?.approve || initial?.approval))
  const listRef = useRef<HTMLUListElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  // After a revoke the row (and its button) is gone: land on the next row, else the previous,
  // else Create key. A cancelled revoke keeps the row, so the dialog's default return wins.
  const focusAfterRevoke = (): HTMLElement | null => {
    if (!revoking || listRef.current?.querySelector(`[data-key-id="${CSS.escape(revoking.id)}"]`)) {
      return null
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-key-id]') ?? [])]
    const next = rows[revokedIndex.current] ?? rows[revokedIndex.current - 1]
    return next?.querySelector<HTMLElement>('button[data-revoke]') ?? createRef.current
  }
  const revokedIndex = useRef(0)
  const lastCreatedId = useRef<string | null>(null)
  const available = keys.status === 'ok' ? keys.data.availableScopes : (viewer?.scopes ?? [])
  const orgAdmin = Boolean(viewer?.orgId) && isAdmin(viewer)

  const createButton = (
    <Button
      ref={createRef}
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
                  'As a team admin you see every key on your team and can revoke any of them.'
                )
              : t(
                  'auto.components.settings.cloudApi.keys.scopeMember',
                  'You see the keys you created. Team admins see every key on the team.'
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
              onClick={keys.status === 'loading' || props.refreshing ? undefined : props.onRefresh}
              aria-disabled={keys.status === 'loading' || props.refreshing}
              aria-busy={props.refreshing}
              aria-label={t(
                'auto.components.settings.cloudApi.keys.refresh',
                'Refresh Orca API keys'
              )}
            >
              <RefreshCw
                className={cn(
                  (keys.status === 'loading' || props.refreshing) &&
                    'animate-spin motion-reduce:animate-none'
                )}
              />
            </Button>
            {keys.status === 'ok' && keys.data.keys.length === 0 ? null : createButton}
          </div>
        }
      >
        {keys.status === 'loading' ? (
          <CloudApiSkeletonRows
            label={t('auto.components.settings.cloudApi.keys.loading', 'Loading Orca API keys')}
          />
        ) : keys.status === 'error' ? (
          <div data-settings-row="" className="py-4">
            <CloudApiErrorNotice message={keys.message} onRetry={props.onRefresh} />
          </div>
        ) : keys.data.keys.length === 0 ? (
          <CloudApiEmptyState
            icon={KeyRound}
            title={t('auto.components.settings.cloudApi.keys.emptyTitle', 'No Orca API keys yet')}
            description={t(
              'auto.components.settings.cloudApi.keys.emptyBody',
              'Create a key to start workspaces, message agents and run routines from scripts, CI or any MCP client.'
            )}
            action={createButton}
          />
        ) : (
          <ul
            ref={listRef}
            aria-label={t('auto.components.settings.cloudApi.keys.listLabel', 'Orca API keys')}
          >
            {keys.data.keys.map((key, index) => (
              <KeyRow
                key={key.id}
                apiKey={key}
                viewer={viewer}
                now={props.now}
                onRevoke={() => {
                  revokedIndex.current = index
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
        onCreate={async (input) => {
          const result = await props.onCreate(input)
          if (result.ok) {
            lastCreatedId.current = result.data.key?.id ?? null
          }
          return result
        }}
        initialCreated={initial?.created}
        returnFocusTo={() => {
          const id = lastCreatedId.current
          const row = id
            ? listRef.current?.querySelector<HTMLElement>(`[data-key-id="${CSS.escape(id)}"]`)
            : null
          return (
            row?.querySelector<HTMLElement>('button[data-revoke]') ??
            listRef.current?.querySelector<HTMLElement>('button[data-revoke]') ??
            createRef.current
          )
        }}
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
        title={t('auto.components.settings.cloudApi.revoke.title', 'Revoke “{{keyName}}”?', {
          keyName: revoking?.name ?? ''
        })}
        description={
          <>
            <p>
              {t(
                'auto.components.settings.cloudApi.revoke.body',
                'Anything using {{keyPrefix}} stops working immediately. This cannot be undone.',
                { keyPrefix: revoking ? formatKeyPrefix(revoking.prefix) : '' }
              )}
            </p>
            {revoking && viewer && revoking.createdBy !== viewer.userId ? (
              <p>
                <PersonSentence
                  sentence={t(
                    'auto.components.settings.cloudApi.revoke.createdByOther',
                    '<person></person> created this key and may still be using it.'
                  )}
                  name={revoking.createdByName}
                  id={revoking.createdBy}
                />
              </p>
            ) : null}
            {revokingApps > 0 ? (
              <p>
                {t(
                  'auto.components.settings.cloudApi.revoke.appsCount',
                  '{{count}} apps approved with this key are disconnected too.',
                  {
                    count: revokingApps,
                    defaultValue_one: 'An app approved with this key is disconnected too.'
                  }
                )}
              </p>
            ) : null}
          </>
        }
        confirmLabel={t('auto.components.settings.cloudApi.revoke.confirm', 'Revoke key')}
        returnFocusTo={focusAfterRevoke}
        onConfirm={async () => {
          if (!revoking) {
            return null
          }
          const failure = await props.onRevoke(revoking)
          if (!failure) {
            toast.success(
              t('auto.components.settings.cloudApi.revoke.done', 'Revoked “{{keyName}}”', {
                keyName: revoking.name
              })
            )
          }
          return failure
        }}
      />
    </div>
  )
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
  const mine = viewer?.userId === apiKey.createdBy
  const expiresSoon = apiKey.expiresAt !== null && apiKey.expiresAt - now < EXPIRY_WARNING_MS
  const created = formatRelativeFromNow(apiKey.createdAt, now, locale)
  return (
    <li data-settings-row="" data-key-id={apiKey.id} className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="truncate text-sm font-medium" title={apiKey.name}>
            {apiKey.name}
          </p>
          <code className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatKeyPrefix(apiKey.prefix)}
          </code>
          <ScopeSummary scopes={apiKey.scopes} />
        </div>
        <p className="text-xs text-muted-foreground">
          <time
            dateTime={new Date(apiKey.createdAt).toISOString()}
            title={formatAbsoluteTime(apiKey.createdAt, locale)}
          >
            {mine ? (
              t('auto.components.settings.cloudApi.keys.createdMine', 'Created {{time}}', {
                time: created
              })
            ) : (
              <PersonSentence
                sentence={t(
                  'auto.components.settings.cloudApi.keys.createdByPerson',
                  'Created by <person></person> {{time}}',
                  { time: created }
                )}
                name={apiKey.createdByName}
                id={apiKey.createdBy}
              />
            )}
          </time>
          <span aria-hidden> · </span>
          <span>
            {apiKey.lastUsedAt
              ? t('auto.components.settings.cloudApi.keys.lastUsed', 'Last used {{time}}', {
                  time: formatRelativeFromNow(apiKey.lastUsedAt, now, locale)
                })
              : t('auto.components.settings.cloudApi.keys.neverUsed', 'Never used')}
          </span>
          {apiKey.expiresAt !== null ? (
            <>
              <span aria-hidden> · </span>
              <span className={cn(expiresSoon && 'text-status-warning-text')}>
                {apiKey.expiresAt <= now
                  ? t('auto.components.settings.cloudApi.keys.expired', 'Expired')
                  : t('auto.components.settings.cloudApi.keys.expires', 'Expires {{time}}', {
                      time: formatRelativeFromNow(apiKey.expiresAt, now, locale)
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
        data-revoke=""
        onClick={onRevoke}
        aria-label={t('auto.components.settings.cloudApi.keys.revokeLabel', 'Revoke {{keyName}}', {
          keyName: apiKey.name
        })}
      >
        <Trash2 />
        {t('auto.components.settings.cloudApi.keys.revoke', 'Revoke')}
      </Button>
    </li>
  )
}
