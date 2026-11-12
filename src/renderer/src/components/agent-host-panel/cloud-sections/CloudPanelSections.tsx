import React from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { maskedHint } from '@/components/settings/cloud-secrets/CloudSecretList'
import {
  cloudSecretScopeLabel,
  cloudSecretsErrorCopy
} from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import { cn } from '@/lib/class-names'
import type {
  CloudSecretScope,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { CloudMissingSecretRow } from './CloudMissingSecretRow'
import { LoadingRows, PanelSection } from './PanelSection'
import {
  cloudEnvRows,
  cloudKeyRows,
  type CloudKeyOwner,
  type CloudKeyRow,
  type ShadowedKey
} from './cloud-panel-sections-model'
import {
  isGuestInSharedWorkspace,
  type CloudPanelAddSecret,
  type CloudPanelSectionsLoad
} from './use-cloud-panel-sections'

const OWNER_LABEL: Record<Exclude<CloudKeyOwner, 'gateway' | 'aws' | 'other'>, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  copilot: 'Copilot'
}

function ownerLabel(owner: CloudKeyOwner, t: Translate): string {
  switch (owner) {
    case 'gateway':
      return t('agentHostPanel.keys.gateway', 'AI Gateway')
    case 'aws':
      return 'AWS'
    case 'other':
      return t('agentHostPanel.keys.other', 'Other')
    case 'claude':
    case 'codex':
    case 'gemini':
    case 'cursor':
    case 'copilot':
      return OWNER_LABEL[owner]
  }
}

/** A read that failed: transport problems say where, without the save-oriented "Nothing was changed". */
export function cloudPanelLoadErrorTitle(code: CloudSecretsErrorCode, t: Translate): string {
  return code === 'unavailable' || code === 'timeout' || code === 'unknown'
    ? t('agentHostPanel.unreachable', 'Couldn’t reach Orca Cloud.')
    : cloudSecretsErrorCopy(code, t)
}

function shadowedReason(shadowedBy: CloudSecretScope, t: Translate): string {
  return shadowedBy === 'org'
    ? t('cloudAgents.source.shadowedByTeam', 'Not used while the team key is set.')
    : t('cloudAgents.source.shadowedByRepo', 'Not used while the repository key is set.')
}

function ShadowedKeyLine({ name, entry }: { name: string; entry: ShadowedKey }): React.JSX.Element {
  const t = useTranslate()
  return (
    <li
      aria-disabled="true"
      className="flex min-w-0 flex-col gap-0.5 text-xs leading-5 text-muted-foreground/80"
    >
      <span className="truncate font-mono line-through decoration-muted-foreground/50">
        {name} {maskedHint(entry.hint)}
      </span>
      <span>
        {cloudSecretScopeLabel(entry.scope, t)} · {shadowedReason(entry.shadowedBy, t)}
      </span>
    </li>
  )
}

function KeyRow({
  row,
  onEdit
}: {
  row: CloudKeyRow
  onEdit?: (row: CloudKeyRow) => void
}): React.JSX.Element {
  const t = useTranslate()
  const scope = cloudSecretScopeLabel(row.scope, t)
  const detail = row.editable
    ? row.shadowed.length > 0
      ? t('agentHostPanel.keys.overrides', '{{scope}} · overrides {{others}}', {
          scope,
          others: row.shadowed.map((entry) => cloudSecretScopeLabel(entry.scope, t)).join(', ')
        })
      : scope
    : t('agentHostPanel.keys.readOnly', '{{scope}} · only owners and admins can change it', {
        scope
      })
  return (
    <li className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5">
      <span className="pt-px text-sm text-foreground">{ownerLabel(row.owner, t)}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs text-foreground">
            {row.name} {maskedHint(row.hint)}
          </span>
          <span className="text-xs text-muted-foreground">{detail}</span>
        </div>
        {row.shadowed.length > 0 ? (
          <ul
            aria-label={t('agentHostPanel.keys.shadowedLabel', 'Keys not used for {{name}}', {
              name: row.name
            })}
            className="flex flex-col gap-1 border-l border-border ps-2.5"
          >
            {row.shadowed.map((entry) => (
              <ShadowedKeyLine key={entry.scope} name={row.name} entry={entry} />
            ))}
          </ul>
        ) : null}
      </div>
      {row.editable && onEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onEdit(row)}
          aria-label={t('agentHostPanel.keys.editLabel', 'Edit {{name}}', { name: row.name })}
        >
          {t('agentHostPanel.keys.edit', 'Edit')}
        </Button>
      ) : (
        <span />
      )}
    </li>
  )
}

/**
 * Panel section 2 on Orca Cloud: the agent keys a workspace gets from Cloud secrets, the winning
 * scope first and any key it hides listed disabled with the reason. Desktop keys never appear here;
 * the shell appends its "Use in Orca Cloud" offer through `extraRows`.
 */
export function CloudAgentKeysSection({
  load,
  number,
  onEdit,
  onManage,
  onRetry,
  extraRows
}: {
  load: CloudPanelSectionsLoad
  number?: React.ReactNode
  onEdit?: (row: CloudKeyRow) => void
  /** Opens Cloud secrets (Settings), where keys are added. */
  onManage?: () => void
  onRetry: () => void
  extraRows?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const rows = load.status === 'ready' ? cloudKeyRows(load.data.effective) : []
  return (
    <PanelSection
      number={number}
      title={t('agentHostPanel.section.keysCloud', 'API keys from Cloud secrets')}
      help={t(
        'agentHostPanel.help.cloudKeys',
        'From your Orca account and Cloud secrets. Keys only on this computer aren’t sent to Orca Cloud.'
      )}
    >
      {load.status === 'ready' && load.data.sharing?.shared ? (
        <InlineError
          layout="line"
          tone="neutral"
          title={t('agentSources.shared', 'Personal accounts aren’t used in shared workspaces.')}
        />
      ) : null}
      {load.status === 'loading' ? (
        <LoadingRows />
      ) : load.status === 'failed' ? (
        <InlineError
          density="compact"
          title={cloudPanelLoadErrorTitle(load.error, t)}
          retryLabel={t('agentHostPanel.retry', 'Try again')}
          onRetry={onRetry}
        />
      ) : rows.length === 0 && !extraRows ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t('agentHostPanel.keys.empty', 'No agent keys in Cloud secrets.')}{' '}
            {load.data.effective.caller.canWrite.org
              ? null
              : t(
                  'agentHostPanel.keys.emptyMember',
                  'Add your own, or ask an owner or admin for a team key.'
                )}
          </p>
          {onManage ? (
            <Button type="button" variant="outline" size="xs" onClick={onManage}>
              {t('agentHostPanel.keys.manage', 'Open Cloud secrets')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {rows.map((row) => (
            <KeyRow key={row.name} row={row} onEdit={onEdit} />
          ))}
          {extraRows}
        </ul>
      )}
    </PanelSection>
  )
}

/**
 * Panel section 3 on Orca Cloud: the variables the workspace gets (winning scope and what it
 * overrides), then the environment's declared names nobody provides, each with an inline Add
 * (members: Add mine, Personal only).
 */
export function CloudEnvironmentPanelSection({
  load,
  number,
  onRetry,
  onAdd,
  focusSecret,
  initialExpanded = null,
  showLoadError = true
}: {
  load: CloudPanelSectionsLoad
  number?: React.ReactNode
  onRetry: () => void
  onAdd: CloudPanelAddSecret
  /** Off when section 2 already shows the shared read's error. */
  showLoadError?: boolean
  /** Deep link `{ secret: NAME }`: that missing row opens with its field focused. */
  focusSecret?: string
  /** Fixtures only: a row shown already expanded. */
  initialExpanded?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = React.useState<string | null>(focusSecret ?? initialExpanded)
  const data = load.status === 'ready' ? load.data : null
  const rows = data ? cloudEnvRows(data.effective, data.missing) : []
  const missingCount = data?.missing.length ?? 0
  return (
    <PanelSection
      number={number}
      title={t('agentHostPanel.section.env', 'Environment')}
      help={
        data && isGuestInSharedWorkspace(data)
          ? `${t('agentHostPanel.help.cloudEnv', 'From Cloud secrets: Repository, then Personal, then Shared.')} ${
              data.sharing?.ownerName
                ? t(
                    'agentHostPanel.env.guestOwner',
                    'In a shared workspace, Personal values come from its owner, {{owner}}, not from you.',
                    { owner: data.sharing.ownerName }
                  )
                : t(
                    'agentHostPanel.env.guest',
                    'In a shared workspace, Personal values come from its owner, not from you.'
                  )
            }`
          : t(
              'agentHostPanel.help.cloudEnv',
              'From Cloud secrets: Repository, then Personal, then Shared.'
            )
      }
      footer={
        data?.asleep ? (
          <p className="text-xs text-muted-foreground">
            {t('agentHostPanel.asleepFooter', 'Changes reach the sandbox when it wakes.')}
          </p>
        ) : null
      }
    >
      {load.status === 'loading' ? (
        <LoadingRows />
      ) : load.status === 'failed' ? (
        showLoadError ? (
          <InlineError
            density="compact"
            title={cloudPanelLoadErrorTitle(load.error, t)}
            retryLabel={t('agentHostPanel.retry', 'Try again')}
            onRetry={onRetry}
          />
        ) : null
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('agentHostPanel.env.empty', 'No variables from Cloud secrets yet.')}
        </p>
      ) : (
        <>
          <span role="status" className="sr-only">
            {missingCount > 0
              ? t('cloudSecretsAsk.missing', '{{count}} secrets missing', {
                  count: missingCount,
                  defaultValue_one: '{{count}} secret missing'
                })
              : ''}
          </span>
          <ul className="flex flex-col divide-y divide-border/60">
            {rows.map((row) =>
              row.kind === 'set' ? (
                <li key={row.name} className="flex min-w-0 flex-wrap items-center gap-2 py-2.5">
                  <code className="truncate font-mono text-xs text-foreground">{row.name}</code>
                  <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    {cloudSecretScopeLabel(row.scope, t)}
                  </span>
                  {row.overrides.length > 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {t('agentHostPanel.env.overrides', 'overrides {{scopes}}', {
                        scopes: row.overrides
                          .map((scope) => cloudSecretScopeLabel(scope, t))
                          .join(', ')
                      })}
                    </span>
                  ) : null}
                </li>
              ) : data ? (
                <CloudMissingSecretRow
                  key={row.name}
                  name={row.name}
                  data={data}
                  expanded={expanded === row.name}
                  onExpand={() => setExpanded(row.name)}
                  onCollapse={() => setExpanded(null)}
                  onAdd={onAdd}
                  autoFocus={expanded === row.name && focusSecret === row.name}
                />
              ) : null
            )}
          </ul>
        </>
      )}
    </PanelSection>
  )
}

/** Both Cloud sections, as the panel shell mounts them under section 1. */
export function CloudPanelSections({
  load,
  onRetry,
  onAdd,
  onEdit,
  onManage,
  focusSecret,
  keysExtraRows,
  initialExpanded,
  className
}: {
  load: CloudPanelSectionsLoad
  onRetry: () => void
  onAdd: CloudPanelAddSecret
  onEdit?: (row: CloudKeyRow) => void
  onManage?: () => void
  focusSecret?: string
  keysExtraRows?: React.ReactNode
  initialExpanded?: string | null
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col divide-y divide-border', className)}>
      <CloudAgentKeysSection
        load={load}
        onEdit={onEdit}
        onManage={onManage}
        onRetry={onRetry}
        extraRows={keysExtraRows}
      />
      <CloudEnvironmentPanelSection
        load={load}
        onRetry={onRetry}
        onAdd={onAdd}
        focusSecret={focusSecret}
        initialExpanded={initialExpanded}
        // One read feeds both sections, so section 2 alone shows (and announces) its error.
        showLoadError={false}
      />
    </div>
  )
}
