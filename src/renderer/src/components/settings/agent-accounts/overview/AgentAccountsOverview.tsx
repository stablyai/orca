// S3 "Sign-ins by host": a real table, hosts as rows, Claude and Codex as columns. A row opens that
// host's A16 panel (click or Enter); the one inline action still works without opening it.
import React, { useState } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  agentHostKindLabel,
  type AgentHostKind
} from '../../../agent-host-panel/agent-host-capabilities'
import { HostGlyph, type HostGlyphKind } from '@/components/host-row-icon'
import { SettingsSegmentedControl } from '../../form-controls/SettingsSegmentedControl'
import type { OverviewAction, OverviewRow } from './agent-accounts-overview-model'
import { apiKeyOverridesDetail, overviewCellText } from './overview-copy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { agentName } from '../orca-cloud-accounts-copy'

export type AgentAccountsOverviewProps = {
  rows: readonly OverviewRow[]
  /** True until the host list is known (first render only). */
  loading?: boolean
  signedOutOfOrca: boolean
  /** Inside Settings → Agent accounts the page's Hosts part already titles it. */
  hideHeader?: boolean
  /** "Checked 4 hosts. 2 need attention." after the first pass; empty before. */
  summary: string
  onOpenRow: (row: OverviewRow) => void
  onAction: (row: OverviewRow, action: OverviewAction) => void
  /** Fixtures only: the filter the list opens on. */
  initialFilter?: 'all' | 'attention'
}

function actionLabel(action: OverviewAction, t: Translate): string {
  switch (action.kind) {
    case 'review':
      return t('agentAccountsOverview.action.review', 'Review')
    case 'checkAgain':
      return t('agentAccountsOverview.action.checkAgain', 'Check again')
    case 'accounts':
      return t('agentAccountsOverview.action.accounts', 'Accounts')
    case 'manage':
      return t('agentAccountsOverview.action.manage', 'Manage')
  }
}

function Cell({ row, agent }: { row: OverviewRow; agent: 'claude' | 'codex' }): React.JSX.Element {
  const t = useTranslate()
  const { text, tone } = overviewCellText(row.cells[agent], t)
  return (
    <td className="px-3 py-2.5 align-middle text-sm">
      {row.cells[agent].kind === 'apiKeyOverrides' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="inline-flex rounded-full focus-visible:outline-[var(--focus-ring)]"
            >
              <Badge variant="statusWarning">{text}</Badge>
              <span className="sr-only">. {apiKeyOverridesDetail(agent, t)}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{apiKeyOverridesDetail(agent, t)}</TooltipContent>
        </Tooltip>
      ) : tone === 'warning' ? (
        <Badge variant="statusWarning">{text}</Badge>
      ) : (
        <span className={cn(tone === 'muted' ? 'text-muted-foreground' : 'text-foreground')}>
          {text}
        </span>
      )}
    </td>
  )
}

const GLYPH: Record<AgentHostKind, HostGlyphKind> = {
  local: 'local',
  sshClassic: 'ssh',
  sshOrcad: 'ssh',
  wsl: 'orca-server',
  paired: 'orca-server',
  recipe: 'recipe-vm',
  cloud: 'orca-cloud'
}

function HostHeader({ row }: { row: OverviewRow }): React.JSX.Element {
  const t = useTranslate()
  const name =
    row.kind === 'cloud'
      ? t('agentAccountsOverview.cloud', 'Orca Cloud')
      : row.kind === 'local'
        ? agentHostKindLabel('local', t)
        : row.label
  const detail =
    row.kind === 'cloud'
      ? t('agentAccountsOverview.cloudAll', 'all your cloud workspaces')
      : row.kind === 'local'
        ? null
        : agentHostKindLabel(row.kind, t)
  return (
    <span className="flex min-w-0 items-start gap-2">
      <HostGlyph kind={GLYPH[row.kind]} size={14} className="mt-0.5 shrink-0" />
      {/* Name and detail stack, so neither truncates at Settings width (RA-5, JA-23). */}
      <span className="flex min-w-[6rem] flex-col">
        <span className="break-words text-foreground">{name}</span>
        {detail ? (
          <span className="break-words text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  )
}

export function AgentAccountsOverview(props: AgentAccountsOverviewProps): React.JSX.Element {
  const t = useTranslate()
  const [filter, setFilter] = useState<'all' | 'attention'>(props.initialFilter ?? 'all')
  const attention = props.rows.filter((row) => row.attention).length
  const shown = filter === 'attention' ? props.rows.filter((row) => row.attention) : props.rows
  const onlyLocal = !props.loading && props.rows.every((row) => row.kind === 'local')
  const titleId = React.useId()
  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={props.hideHeader ? 'sr-only' : 'min-w-0'}>
          <h3 id={titleId} className="text-sm font-medium text-foreground">
            {t('agentAccountsOverview.title', 'Sign-ins by host')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              'agentAccountsOverview.description',
              'Where Claude and Codex are signed in, and which key they use. Orca never copies a sign-in between machines.'
            )}
          </p>
        </div>
        <SettingsSegmentedControl
          size="sm"
          value={filter}
          onChange={setFilter}
          ariaLabel={t('agentAccountsOverview.filter', 'Show')}
          options={[
            { value: 'all', label: t('agentAccountsOverview.all', 'All') },
            {
              value: 'attention',
              label: t('agentAccountsOverview.attention', 'Needs attention · {{count}}', {
                count: attention
              })
            }
          ]}
        />
      </div>
      {/* The page's one Sign in button is in the Orca Cloud part; this is only a muted note. */}
      {props.signedOutOfOrca ? (
        <p className="px-1 text-xs text-muted-foreground">
          {t('agentAccountsOverview.signedOutNote', 'Sign in to Orca to see Orca Cloud here.')}
        </p>
      ) : null}
      <div className="overflow-hidden rounded-xl border border-border bg-card/50 shadow-xs">
        {props.loading ? (
          <div aria-busy="true" className="flex flex-col gap-3 p-4">
            {[0, 1, 2].map((line) => (
              <Skeleton key={line} shape="small" className="h-3 w-3/5" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
            {t('agentAccountsOverview.nothingNeedsAttention', 'Nothing needs attention.')}
          </p>
        ) : (
          <table className="w-full table-fixed border-collapse text-start">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="w-[38%] px-3 py-2 text-start font-normal">
                  {t('agentAccountsOverview.host', 'Host')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {agentName('claude', t)}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-normal">
                  {agentName('codex', t)}
                </th>
                <th scope="col" className="w-28 px-3 py-2">
                  <span className="sr-only">{t('agentAccountsOverview.actions', 'Actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  data-host-row={row.id}
                  aria-label={t(
                    'agentAccountsOverview.openRow',
                    'Open agent accounts for {{host}}',
                    {
                      host: row.kind === 'cloud' ? 'Orca Cloud' : row.label
                    }
                  )}
                  className="cursor-pointer border-b border-border/60 last:border-b-0 hover:bg-muted/40 focus-visible:outline-[var(--focus-ring)]"
                  onClick={() => props.onOpenRow(row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.target === event.currentTarget) {
                      props.onOpenRow(row)
                    }
                  }}
                >
                  <th scope="row" className="px-3 py-2.5 text-start text-sm font-normal">
                    <HostHeader row={row} />
                  </th>
                  <Cell row={row} agent="claude" />
                  <Cell row={row} agent="codex" />
                  <td className="px-3 py-2.5 text-end">
                    {row.action ? (
                      <Button
                        type="button"
                        variant={
                          row.action.kind === 'review' || row.action.kind === 'checkAgain'
                            ? 'outline'
                            : 'ghost'
                        }
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          if (row.action) {
                            props.onAction(row, row.action)
                          }
                        }}
                      >
                        {actionLabel(row.action, t)}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {onlyLocal ? (
        <div className="rounded-xl border border-border px-4 py-3">
          <p className="text-sm text-foreground">
            {t('agentAccountsOverview.emptyTitle', 'Only this computer so far')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(
              'agentAccountsOverview.emptyDetail',
              'When you add an SSH host, pair a machine or start a cloud workspace, its sign-ins show up here.'
            )}
          </p>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {props.summary}
      </p>
    </section>
  )
}
