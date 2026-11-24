import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import type { CommanderMemoryRevision } from '../../../../shared/commander/memory-contract'
import {
  recurringQuestionLimit,
  recurringAnswerLimit
} from '../../../../shared/commander/recurring-answer'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export type MemoryDraft = Pick<
  CommanderMemoryRevision,
  'title' | 'body' | 'kind' | 'links' | 'projectId'
> & {
  recurring?: { question: string; answer: string }
  base: number
  baseLinks: string[]
}
export function CommanderMemoryFields({
  draft,
  setDraft,
  oversized,
  projects
}: {
  draft: MemoryDraft
  setDraft: (value: MemoryDraft) => void
  oversized: boolean
  projects: readonly string[]
}): React.JSX.Element {
  const t = useTranslate()
  const rule = draft.recurring
  if (rule) {
    return (
      <>
        <h2 className="text-lg font-semibold">
          {t('commander.rules.singular', 'Recurring answer')}
        </h2>
        <p className="text-xs text-muted-foreground">
          {t(
            'commander.rules.hint',
            'Commander may use this answer when an Orca question matches exactly in this project.'
          )}
        </p>
        {draft.base === 0 && (
          <Select
            value={draft.projectId ?? ''}
            onValueChange={(projectId) => setDraft({ ...draft, projectId })}
          >
            <SelectTrigger aria-label={t('commander.memory.scope', 'Memory project')} size="sm">
              <SelectValue placeholder={t('commander.rules.project', 'Choose a project')} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <label className="block space-y-1">
          <span>{t('commander.rules.question', 'Exact question')}</span>
          <Textarea
            required
            rows={2}
            maxLength={recurringQuestionLimit}
            value={rule.question}
            onChange={(e) =>
              setDraft({ ...draft, recurring: { ...rule, question: e.target.value } })
            }
          />
        </label>
        <label className="block space-y-1">
          <span>{t('commander.rules.answer', 'Answer')}</span>
          <Textarea
            required
            rows={3}
            maxLength={recurringAnswerLimit}
            value={rule.answer}
            onChange={(e) => setDraft({ ...draft, recurring: { ...rule, answer: e.target.value } })}
          />
        </label>
      </>
    )
  }
  return (
    <>
      <label className="block space-y-1">
        <span>{t('commander.memory.title', 'Page title')}</span>
        <Input
          required
          maxLength={240}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />
      </label>
      <Select
        value={draft.kind}
        disabled={draft.base !== 0}
        onValueChange={(kind: MemoryDraft['kind']) => setDraft({ ...draft, kind })}
      >
        <SelectTrigger aria-label={t('commander.memory.kind', 'Page type')} size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="guideline">{t('commander.memory.guideline', 'Guideline')}</SelectItem>
          <SelectItem value="decision">{t('commander.memory.decision', 'Decision')}</SelectItem>
          <SelectItem value="note">{t('commander.memory.note', 'Note')}</SelectItem>
        </SelectContent>
      </Select>
      <label className="block space-y-1">
        <span>{t('commander.memory.markdown', 'Markdown')}</span>
        <Textarea
          className="min-h-44"
          variant="code"
          aria-invalid={oversized}
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
        />
      </label>
      {oversized && (
        <p className="text-xs text-destructive">
          {t('commander.memory.sizeLimit', 'Keep Markdown under 64 KiB.')}
        </p>
      )}
    </>
  )
}
