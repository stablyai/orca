// Settings › Enterprise › Audit log: every recorded change for the team in one list, filtered by
// category and by person, with CSV export. Owners and admins only. A team whose plan does not
// include it sees the upsell instead; the control plane refuses the data either way.
import { Download, History, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import {
  CLOUD_AUDIT_CATEGORIES,
  type CloudAuditActor,
  type CloudAuditCategory,
  type CloudAuditEvent
} from '../../../../../shared/cloud-api/cloud-api-types'
import { PersonName, PersonSentence } from '../cloud-api/PersonName'
import { formatAbsoluteTime, formatRelativeFromNow } from '../cloud-api/cloud-api-format'
import {
  CloudApiEmptyState,
  CloudApiErrorNotice,
  CloudApiSkeletonRows
} from '../cloud-api/cloud-api-parts'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { EnterpriseUpsell, EnterpriseUpsellLine, type EnterpriseContact } from './EnterpriseUpsell'
import { auditCategoryLabel, auditEventSentence } from './enterprise-audit-copy'

export type AuditLogFilters = { category: CloudAuditCategory | null; actor: string | null }

export type AuditLogState =
  | { status: 'loading' }
  /** The team's plan does not include the audit log. */
  | { status: 'upsell' }
  | { status: 'error'; message: string }
  | {
      status: 'ok'
      events: CloudAuditEvent[]
      /** More events exist past the ones loaded. */
      hasMore: boolean
      loadingMore: boolean
      /** A failed "Show more" keeps the list and says so under it. */
      moreError: string | null
      /** A filter change is loading; the previous list stays on screen, dimmed. */
      refreshing: boolean
    }

export type AuditLogExportState =
  | { status: 'idle' }
  | { status: 'exporting' }
  /** Saved; `truncated` means the file holds the newest events only. */
  | { status: 'done'; truncated: boolean }
  | { status: 'error'; message: string }

export type EnterpriseAuditLogProps = {
  log: AuditLogState
  filters: AuditLogFilters
  /** Everyone who appears in the log, for the person filter. */
  actors: readonly CloudAuditActor[]
  exportState: AuditLogExportState
  now: number
  viewerUserId: string | null
  contact: EnterpriseContact
  onFilter: (filters: AuditLogFilters) => void
  onLoadMore: () => void
  onRetry: () => void
  onExport: () => void
  onContactSales: (url: string) => void
  /** False when the page banner already carries Contact sales: the upsell is then a plain line. */
  upsellButton?: boolean
}

const ALL = '__all__'
const SYSTEM = 'system'

function ActorCell({
  event,
  viewerUserId
}: {
  event: CloudAuditEvent
  viewerUserId: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const { actor } = event
  if (actor.kind === 'system' || !actor.userId) {
    return <>{t('settings.enterprise.audit.actor.system', 'Orca')}</>
  }
  const mine = actor.userId === viewerUserId
  const sentence =
    actor.via === 'api_key'
      ? mine
        ? t('auto.components.settings.cloudApi.audit.youViaKey', 'You via API key')
        : t('auto.components.settings.cloudApi.audit.personViaKey', '<person></person> via API key')
      : actor.via === 'mcp'
        ? mine
          ? t('auto.components.settings.cloudApi.audit.youViaMcp', 'You via MCP')
          : t('auto.components.settings.cloudApi.audit.personViaMcp', '<person></person> via MCP')
        : actor.via === 'agent'
          ? mine
            ? t('settings.enterprise.audit.actor.youViaAgent', 'Your agent')
            : t('settings.enterprise.audit.actor.personViaAgent', '<person></person>’s agent')
          : actor.via === 'routine'
            ? mine
              ? t('settings.enterprise.audit.actor.youViaRoutine', 'Your routine')
              : t('settings.enterprise.audit.actor.personViaRoutine', '<person></person>’s routine')
            : mine
              ? t('auto.components.settings.cloudApi.audit.you', 'You')
              : '<person></person>'
  if (mine) {
    return <>{sentence}</>
  }
  return (
    <>
      <PersonSentence sentence={sentence} name={actor.name} id={actor.userId} idInTooltip />
      {/* A named person who has left: say so, or they read as a current teammate. */}
      {actor.kind === 'former_member' && actor.name ? (
        <span className="text-muted-foreground">
          {' · '}
          {t('auto.components.settings.cloudApi.formerMember', 'Former member')}
        </span>
      ) : null}
    </>
  )
}

function actorOptionLabel(actor: CloudAuditActor, viewerUserId: string | null, t: Translate) {
  if (actor.userId && actor.userId === viewerUserId) {
    return t('auto.components.settings.cloudApi.audit.you', 'You')
  }
  return (
    <>
      <PersonName name={actor.name} id={actor.userId ?? ''} />
      {actor.kind === 'former_member' && actor.name ? (
        <span className="ml-1.5 text-muted-foreground">
          {t('auto.components.settings.cloudApi.formerMember', 'Former member')}
        </span>
      ) : null}
    </>
  )
}

function Filters({
  filters,
  actors,
  viewerUserId,
  disabled,
  onFilter
}: Pick<EnterpriseAuditLogProps, 'filters' | 'actors' | 'viewerUserId' | 'onFilter'> & {
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div data-settings-row="" className="flex flex-wrap items-center gap-2 py-3">
      <Select
        value={filters.category ?? ALL}
        disabled={disabled}
        onValueChange={(value) =>
          // SAFETY: every option's value is ALL or a member of CLOUD_AUDIT_CATEGORIES.
          onFilter({ ...filters, category: value === ALL ? null : (value as CloudAuditCategory) })
        }
      >
        <SelectTrigger
          size="sm"
          className="w-44"
          aria-label={t('settings.enterprise.audit.filter.categoryLabel', 'Filter by activity')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={ALL}>
            {t('settings.enterprise.audit.filter.allActivity', 'All activity')}
          </SelectItem>
          {CLOUD_AUDIT_CATEGORIES.filter((category) => category !== 'other').map((category) => (
            <SelectItem key={category} value={category}>
              {auditCategoryLabel(category, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={filters.actor ?? ALL}
        disabled={disabled}
        onValueChange={(value) => onFilter({ ...filters, actor: value === ALL ? null : value })}
      >
        <SelectTrigger
          size="sm"
          className="w-52"
          aria-label={t('settings.enterprise.audit.filter.actorLabel', 'Filter by person')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value={ALL}>
            {t('settings.enterprise.audit.filter.everyone', 'Everyone')}
          </SelectItem>
          {actors
            .filter((actor) => actor.userId)
            .map((actor) => (
              <SelectItem key={actor.userId} value={actor.userId ?? ''}>
                {actorOptionLabel(actor, viewerUserId, t)}
              </SelectItem>
            ))}
          <SelectItem value={SYSTEM}>
            {t('settings.enterprise.audit.actor.system', 'Orca')}
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

export function EnterpriseAuditLog(props: EnterpriseAuditLogProps): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const { log, filters, exportState } = props
  const filtered = filters.category !== null || filters.actor !== null
  const canExport = log.status === 'ok' && log.events.length > 0
  return (
    <SettingsGroup
      title={t('settings.enterprise.audit.title', 'Audit log')}
      description={t(
        'settings.enterprise.audit.description',
        'Member, key, secret, workspace and settings changes across your team. Only owners and admins can see it.'
      )}
      action={
        log.status === 'ok' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canExport}
            aria-disabled={exportState.status === 'exporting'}
            aria-busy={exportState.status === 'exporting'}
            onClick={() => (exportState.status === 'exporting' ? undefined : props.onExport())}
          >
            {exportState.status === 'exporting' ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Download />
            )}
            {t('settings.enterprise.audit.export', 'Export CSV')}
          </Button>
        ) : undefined
      }
    >
      {log.status === 'upsell' && props.upsellButton === false ? (
        <EnterpriseUpsellLine>
          {t(
            'settings.enterprise.audit.upsellBody',
            'Orca records your team’s changes on every plan, so your full history is here from the day you upgrade.'
          )}
        </EnterpriseUpsellLine>
      ) : log.status === 'upsell' ? (
        <EnterpriseUpsell
          title={t('settings.enterprise.audit.upsellTitle', 'Audit log is part of {{plan}}', {
            plan: props.contact.planName
          })}
          body={t(
            'settings.enterprise.audit.upsellBody',
            'Orca records your team’s changes on every plan, so your full history is here from the day you upgrade.'
          )}
          contact={props.contact}
          onContactSales={props.onContactSales}
        />
      ) : log.status === 'loading' ? (
        <CloudApiSkeletonRows
          rows={3}
          label={t('settings.enterprise.audit.loading', 'Loading the audit log')}
        />
      ) : log.status === 'error' ? (
        <div data-settings-row="" className="py-4">
          <CloudApiErrorNotice message={log.message} onRetry={props.onRetry} />
        </div>
      ) : (
        <>
          {/* Nothing to narrow down in a log with nothing in it. */}
          {filtered || log.events.length > 0 ? (
            <Filters
              filters={filters}
              actors={props.actors}
              viewerUserId={props.viewerUserId}
              disabled={log.refreshing}
              onFilter={props.onFilter}
            />
          ) : null}
          {exportState.status === 'error' ? (
            <div data-settings-row="" className="py-3">
              <InlineError title={exportState.message} />
            </div>
          ) : exportState.status === 'done' && exportState.truncated ? (
            <p data-settings-row="" role="status" className="py-3 text-xs text-muted-foreground">
              {t(
                'settings.enterprise.audit.exportTruncated',
                'The file has the newest 5,000 events. Filter by activity or person to export the rest.'
              )}
            </p>
          ) : null}
          {log.events.length === 0 ? (
            <div data-settings-row="">
              <CloudApiEmptyState
                icon={History}
                title={
                  filtered
                    ? t('settings.enterprise.audit.emptyFilteredTitle', 'Nothing matches')
                    : t('settings.enterprise.audit.emptyTitle', 'Nothing recorded yet')
                }
                description={
                  filtered
                    ? t(
                        'settings.enterprise.audit.emptyFilteredBody',
                        'No recorded change matches these filters.'
                      )
                    : t(
                        'settings.enterprise.audit.emptyBody',
                        'Changes to members, API keys, secrets, workspaces and settings will show up here.'
                      )
                }
                action={
                  filtered ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => props.onFilter({ category: null, actor: null })}
                    >
                      {t('settings.enterprise.audit.clearFilters', 'Clear filters')}
                    </Button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <ul
              aria-label={t('settings.enterprise.audit.title', 'Audit log')}
              aria-busy={log.refreshing}
              className={log.refreshing ? 'opacity-60' : undefined}
            >
              {log.events.map((event) => (
                <li
                  key={event.id}
                  data-settings-row=""
                  className="flex items-center gap-3 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate text-foreground" title={event.action}>
                    {auditEventSentence(event, t)}
                  </span>
                  <span className="w-28 shrink-0 truncate text-muted-foreground">
                    {auditCategoryLabel(event.category, t)}
                  </span>
                  <span className="w-48 shrink-0 truncate text-foreground">
                    <ActorCell event={event} viewerUserId={props.viewerUserId} />
                  </span>
                  <span
                    className="w-24 shrink-0 text-right text-muted-foreground"
                    title={formatAbsoluteTime(event.at, locale)}
                  >
                    {formatRelativeFromNow(event.at, props.now, locale)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {log.moreError ? (
            <div data-settings-row="" className="py-3">
              <CloudApiErrorNotice message={log.moreError} onRetry={props.onLoadMore} />
            </div>
          ) : log.hasMore ? (
            <div data-settings-row="" className="flex justify-center py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-disabled={log.loadingMore}
                aria-busy={log.loadingMore}
                onClick={() => (log.loadingMore ? undefined : props.onLoadMore())}
              >
                {log.loadingMore ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : null}
                {t('settings.enterprise.audit.showMore', 'Show more')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SettingsGroup>
  )
}
