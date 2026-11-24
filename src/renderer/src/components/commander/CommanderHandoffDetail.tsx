import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { HandoffFields } from '../../../../shared/commander/goal-handoff'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'
import { CommanderWorkerResume } from './CommanderWorkerResume'
import { CommanderHandoffMetadata } from './CommanderHandoffMetadata'
import { MemoryHistory } from './CommanderMemoryHistory'
import type { WorkerHandoffDestination } from './handoff-workspaces'

export function CommanderHandoffDetail({
  account,
  page,
  fields,
  busy,
  error,
  onBack,
  onEdit,
  onRefresh,
  onResume
}: {
  account: CommanderAccount
  page: CommanderMemoryRevision
  fields: HandoffFields
  busy: boolean
  error: string
  onBack: () => void
  onEdit: () => void
  onRefresh: () => void
  onResume: (target: true | WorkerHandoffDestination) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section
      className="max-w-3xl space-y-4 px-4 py-3 text-sm"
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' &&
          !event.defaultPrevented &&
          !busy &&
          !(event.target instanceof HTMLSelectElement)
        ) {
          event.stopPropagation()
          onBack()
        }
      }}
    >
      <Button size="sm" variant="ghost" disabled={busy} autoFocus onClick={onBack}>
        <ArrowLeft />
        {t('commander.handoffs.tab', 'Handoffs')}
      </Button>
      <h2 className="break-words text-lg font-semibold">{fields.goal}</h2>
      <CommanderHandoffMetadata page={page} showActor />
      <dl className="space-y-3">
        {[
          [t('commander.handoffs.progress', 'Progress'), fields.progress],
          [t('commander.handoffs.next', 'Next step'), fields.nextStep]
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{label}</dt>
            <dd className="whitespace-pre-wrap break-words">{value || '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => onResume(true)}>
          {t('commander.handoffs.resume', 'Resume in Commander')}
        </Button>
        <Button size="sm" disabled={busy} variant="outline" onClick={onEdit}>
          {t('commander.memory.edit', 'Edit page')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('commander.handoffs.draftHint', 'Review the draft in Commander chat before sending.')}
      </p>
      {page.projectId && (
        <CommanderWorkerResume
          key={page.pageId}
          projectId={page.projectId}
          busy={busy}
          onResume={onResume}
        />
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {page.version > 1 && (
        <MemoryHistory
          key={page.version}
          account={account}
          history={[page]}
          initialCursor={page.version}
          onRefresh={onRefresh}
        />
      )}
    </section>
  )
}
