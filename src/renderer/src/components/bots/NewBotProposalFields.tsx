// New bot's fields for a proposed bot (a template, a suggestion, a bot's card): what it watches, does
// and reports, and the workspaces it takes over.
import { useId } from 'react'
import { GitBranch } from 'lucide-react'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import { BARE_LINE_CLASS } from './new-bot-bare-fields'
import { useTranslate } from '@/i18n/use-translate'
import type { BotProposal } from '../../../../shared/bots/bot-proposal'

export type NewBotProposalDraft = Pick<BotProposal, 'watches' | 'does' | 'reports'>

export function NewBotProposalFields({
  draft,
  worktrees,
  onChange
}: {
  draft: NewBotProposalDraft
  worktrees: BotProposal['worktrees']
  onChange: (draft: NewBotProposalDraft) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  // A quiet labelled list: a small label above, the line as bare editable text across the full width.
  const field = (key: keyof NewBotProposalDraft, label: string) => (
    <div className="space-y-1">
      <label htmlFor={`${id}-${key}`} className="block text-xs text-muted-foreground">
        {label}
      </label>
      <ImeTextarea
        id={`${id}-${key}`}
        className={`${BARE_LINE_CLASS} text-pretty`}
        rows={1}
        value={draft[key] ?? ''}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
      />
    </div>
  )
  return (
    <div className="space-y-4">
      {field('watches', t('bots.new.watches', 'Watches'))}
      {field('does', t('bots.new.does', 'Does'))}
      {field('reports', t('bots.new.reports', 'Reports'))}
      <NewBotTakesOver worktrees={worktrees} />
    </div>
  )
}

/** The workspaces a proposed bot takes over, template or not. */
export function NewBotTakesOver({
  worktrees
}: {
  worktrees: BotProposal['worktrees']
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!worktrees?.length) {
    return null
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t('bots.new.takesOver', 'Takes over')}</p>
      <ul className="flex flex-wrap gap-1.5">
        {worktrees.map((entry) => (
          <li
            key={entry.id}
            className="flex min-w-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
          >
            <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{entry.name}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        {t('bots.new.agentsKeepRunning', 'Their agents keep running.')}
      </p>
    </div>
  )
}
