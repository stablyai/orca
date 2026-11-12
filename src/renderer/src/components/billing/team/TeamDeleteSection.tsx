import { useId } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaOrgDeleteBlocker } from '../../../../../shared/orca-org-delete'
import { teamDeleteBlockerLines } from './team-delete-copy'

/** The pre-check: `checking` until auth answers; a failed check shows no blockers (auth re-checks). */
export type TeamDeleteCheck =
  | { state: 'checking' }
  | { state: 'ready'; blockers: OrcaOrgDeleteBlocker[] }

/** Each blocker's way out, shown as a link after its line. */
export function TeamDeleteBlockers({
  blockers,
  onAction
}: {
  blockers: readonly OrcaOrgDeleteBlocker[]
  onAction: (code: OrcaOrgDeleteBlocker['code']) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ul className="space-y-1">
      {teamDeleteBlockerLines(blockers, t).map((line) => (
        <li key={line.code} className="text-xs text-muted-foreground text-pretty">
          {line.text}{' '}
          <button
            type="button"
            className="rounded-sm whitespace-nowrap text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onAction(line.code)}
          >
            {line.actionLabel}
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Settings › Team danger zone (owners only): "Delete <team>", styled like "Leave <team>". */
export function TeamDeleteSection({
  teamName,
  check,
  onDelete,
  onBlockerAction
}: {
  teamName: string
  check: TeamDeleteCheck
  onDelete: () => void
  onBlockerAction: (code: OrcaOrgDeleteBlocker['code']) => void
}): React.JSX.Element {
  const t = useTranslate()
  const titleId = useId()
  const blockers = check.state === 'ready' ? check.blockers : []
  const blocked = blockers.length > 0
  return (
    <section aria-labelledby={titleId} className="flex flex-wrap items-center gap-3 p-4">
      <div className="min-w-[14rem] flex-1 space-y-1">
        <h3 id={titleId} className="text-sm font-medium">
          {t('auto.components.billing.team.delete.title', 'Delete {{value0}}', {
            value0: teamName
          })}
        </h3>
        <p className="text-xs text-muted-foreground text-pretty">
          {t(
            'auto.components.billing.team.delete.cardBody',
            'Removes the team for everyone. This can’t be undone.'
          )}
        </p>
        {blocked ? <TeamDeleteBlockers blockers={blockers} onAction={onBlockerAction} /> : null}
      </div>
      <Button
        type="button"
        variant="destructive-chip"
        size="sm"
        disabled={blocked}
        aria-busy={check.state === 'checking' || undefined}
        onClick={check.state === 'checking' ? undefined : onDelete}
      >
        <Trash2 />
        {t('auto.components.billing.team.delete.cta', 'Delete team')}
      </Button>
    </section>
  )
}
