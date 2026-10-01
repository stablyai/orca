import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatState, formatWorkspace, generationSessionCount } from './manage-sessions-format'

export type GenerationRowProps = {
  isBusy: boolean
  ptyIdToTabId: Map<string, string>
  onNavigate: (tabId: string) => void
  onRequestKill: (session: PtyManagementSession) => void
}

function GenerationHeaderRow({
  generation,
  isFirstGroup
}: {
  generation: PtyManagementGeneration
  isFirstGroup: boolean
}): React.JSX.Element {
  const count = generationSessionCount(generation)
  return (
    <tr className={cn('bg-muted/40', !isFirstGroup && 'border-t border-border/60')}>
      <th scope="rowgroup" colSpan={4} className="px-3 py-1.5 text-left font-normal">
        <span className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {generation.isCurrent
              ? translate(
                  'auto.components.settings.ManageSessionsTable.d4ae93e65d',
                  'Current version'
                )
              : translate(
                  'auto.components.settings.ManageSessionsTable.285148ee08',
                  'Previous version'
                )}
            <span className="ml-2 font-mono font-normal normal-case tracking-normal">
              {translate(
                'auto.components.settings.ManageSessionsTable.e6ec9241a4',
                'Protocol {{value0}}',
                { value0: generation.protocolVersion }
              )}
            </span>
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {count ??
              translate('auto.components.settings.ManageSessionsTable.4f7c2d9a61', 'unverifiable')}
          </span>
        </span>
      </th>
    </tr>
  )
}

function SessionRow({
  session,
  isBusy,
  ptyIdToTabId,
  onNavigate,
  onRequestKill
}: GenerationRowProps & { session: PtyManagementSession }): React.JSX.Element {
  const state = formatState(session)
  // Why: a same-id copy in another version is not the process the open tab shows.
  const tabId = session.backsTab ? (ptyIdToTabId.get(session.sessionId) ?? null) : null
  const rowClickable = tabId !== null
  return (
    <tr
      className={cn(
        'border-t border-border/50 first:border-t-0',
        rowClickable && 'cursor-pointer hover:bg-accent/60'
      )}
      onClick={rowClickable ? () => onNavigate(tabId) : undefined}
      aria-label={
        rowClickable
          ? translate(
              'auto.components.settings.ManageSessionsSection.2896a50f50',
              'Go to terminal {{value0}}',
              { value0: formatWorkspace(session) }
            )
          : undefined
      }
    >
      <td className="w-6 px-3 py-1.5">
        <span
          className={cn(
            'block size-1.5 rounded-full',
            state === 'running' ? 'bg-status-success' : 'bg-muted-foreground/40'
          )}
          aria-label={state}
          title={state}
        />
      </td>
      <td className="px-3 py-1.5">
        <span className="truncate font-mono font-medium">{formatWorkspace(session)}</span>
      </td>
      <td
        className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
        title={session.sessionId}
      >
        <span className="block max-w-[280px] truncate">{session.sessionId}</span>
      </td>
      <td className="w-10 px-3 py-1.5 text-right">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={(e) => {
            e.stopPropagation()
            onRequestKill(session)
          }}
          disabled={isBusy}
          aria-label={translate(
            'auto.components.settings.ManageSessionsSection.33c2a1e1b4',
            'Kill session {{value0}}',
            { value0: session.sessionId }
          )}
        >
          <X />
        </Button>
      </td>
    </tr>
  )
}

function GenerationNoteRow({
  children,
  title
}: {
  children: string
  title?: string
}): React.JSX.Element {
  return (
    <tr className="border-t border-border/50 first:border-t-0">
      <td colSpan={4} className="px-3 py-2 text-xs text-muted-foreground" title={title}>
        {children}
      </td>
    </tr>
  )
}

/** One version's rows under one shared table, so columns line up across versions. */
export function GenerationRows({
  generation,
  showHeader,
  isFirstGroup,
  ...rowProps
}: GenerationRowProps & {
  generation: PtyManagementGeneration
  showHeader: boolean
  isFirstGroup: boolean
}): React.JSX.Element {
  return (
    <tbody>
      {showHeader ? (
        <GenerationHeaderRow generation={generation} isFirstGroup={isFirstGroup} />
      ) : null}
      {generation.contact === 'unverifiable' ? (
        <GenerationNoteRow title={generation.detail ?? undefined}>
          {translate(
            'auto.components.settings.ManageSessionsTable.3388ec840f',
            'Orca couldn’t reach this version of the terminal service, so its sessions can’t be listed. They are not known to have stopped.'
          )}
        </GenerationNoteRow>
      ) : generation.contact === 'exited' || generation.sessions.length === 0 ? (
        <GenerationNoteRow>
          {translate('auto.components.settings.ManageSessionsSection.e26a60d9eb', 'No sessions.')}
        </GenerationNoteRow>
      ) : (
        generation.sessions.map((session) => (
          <SessionRow key={session.sessionId} session={session} {...rowProps} />
        ))
      )}
    </tbody>
  )
}
