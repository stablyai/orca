import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import {
  encodeHandoffBody,
  readHandoff,
  HANDOFF_GOAL_LIMIT,
  HANDOFF_SECTION_LIMIT,
  type HandoffFields
} from '../../../../shared/commander/goal-handoff'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../../shared/commander/memory-contract'

import { selectedCommanderHost } from './selected-commander-host'

const loadRecent = () => import('./recent-commander-goal')
type Props = {
  account: CommanderAccount
  pageId: string
  page: CommanderMemoryRevision | null
  projectId: string | null
  projectIds: readonly string[]
  isCurrent: () => boolean
  onSaved: (page: CommanderMemoryRevision) => void
  onCancel: () => void
}
const empty: HandoffFields = { goal: '', progress: '', nextStep: '' }

export function CommanderHandoffEditor({
  account,
  pageId,
  page,
  projectId,
  projectIds,
  isCurrent,
  onSaved,
  onCancel
}: Props): React.JSX.Element {
  const t = useTranslate()
  const initial = (page && readHandoff(page)) || empty
  const [draft, setDraft] = useState<HandoffFields>(initial)
  const [base, setBase] = useState(page)
  const [scope, setScope] = useState(page ? (page.projectId ?? null) : projectId)
  const [conflict, setConflict] = useState<CommanderMemoryRevision | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const locked = useRef(false)
  const request = useRef<{ key: string; id: string } | null>(null)
  const dirty =
    draft.goal !== initial.goal ||
    draft.progress !== initial.progress ||
    draft.nextStep !== initial.nextStep ||
    scope !== (page ? (page.projectId ?? null) : projectId)

  async function capture(): Promise<void> {
    if (locked.current) {
      return
    }
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const host = selectedCommanderHost()
      const { recentCommanderGoal } = await loadRecent()
      const recent = await recentCommanderGoal(host)
      if (isCurrent()) {
        if ((!draft.goal.trim() && recent.goal) || (!draft.progress.trim() && recent.progress)) {
          setDraft({
            ...draft,
            goal: draft.goal.trim() ? draft.goal : recent.goal.slice(0, HANDOFF_GOAL_LIMIT),
            progress: draft.progress.trim()
              ? draft.progress
              : recent.progress.slice(0, HANDOFF_SECTION_LIMIT)
          })
        } else {
          setError(t('commander.handoffs.noRecent', 'No recent messages to add on this host.'))
        }
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('commander.handoffs.captureError', 'Could not load the recent conversation.')
      )
    }
    locked.current = false
    setBusy(false)
  }
  async function save(): Promise<void> {
    if (locked.current || !draft.goal.trim() || conflict) {
      return
    }
    locked.current = true
    setBusy(true)
    setError('')
    const edit = {
      pageId,
      expectedVersion: base?.version ?? 0,
      kind: 'note' as const,
      title: draft.goal.trim(),
      body: encodeHandoffBody(draft),
      projectId: scope,
      links: base?.links ?? []
    }
    const key = JSON.stringify(edit)
    if (request.current?.key !== key) {
      request.current = { key, id: createNonSecureContextUuid() }
    }
    try {
      const { page: updated } = await window.api.commanderMemory.save(account, {
        ...edit,
        requestId: request.current.id
      })
      onSaved(updated)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : t('commander.memory.saveError', 'Could not save the page.')
      )
      try {
        const { page: latest } = await window.api.commanderMemory.get(account, pageId, 1)
        if (latest.version > edit.expectedVersion) {
          // A response may be lost after the write commits. Accept an identical
          // current revision; different content needs an explicit comparison.
          if (
            !latest.deleted &&
            latest.title === edit.title &&
            latest.body === edit.body &&
            latest.kind === edit.kind &&
            (latest.projectId ?? null) === scope &&
            JSON.stringify(latest.links) === JSON.stringify(edit.links)
          ) {
            onSaved(latest)
          } else {
            setConflict(latest)
          }
        }
      } catch {
        // Keep the draft and request ID so a disconnected client can retry.
      }
    }
    locked.current = false
    setBusy(false)
  }
  return (
    <section className="max-w-3xl space-y-4 px-4 py-3 text-sm">
      <h2 className="font-medium">
        {page
          ? t('commander.memory.edit', 'Edit page')
          : t('commander.handoffs.new', 'New handoff')}
      </h2>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block space-y-1">
          <span>{t('commander.handoffs.goal', 'Goal')}</span>
          <Input
            autoFocus
            required
            maxLength={HANDOFF_GOAL_LIMIT}
            value={draft.goal}
            onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
          />
        </label>
        <div className="space-y-1">
          <span>{t('commander.project', 'Project')}</span>
          <Select
            value={scope ? `id:${scope}` : 'all'}
            onValueChange={(v) => setScope(v === 'all' ? null : v.slice(3))}
            disabled={busy || !!page}
          >
            <SelectTrigger size="sm" aria-label={t('commander.memory.scope', 'Memory project')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('commander.memory.global', 'Account-wide')}</SelectItem>
              {[...new Set([...projectIds, ...(scope ? [scope] : [])])].sort().map((id) => (
                <SelectItem key={id} value={`id:${id}`}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="block space-y-1">
          <span>{t('commander.handoffs.progress', 'Progress')}</span>
          <Textarea
            rows={4}
            maxLength={HANDOFF_SECTION_LIMIT}
            value={draft.progress}
            onChange={(e) => setDraft({ ...draft, progress: e.target.value })}
          />
        </label>
        <label className="block space-y-1">
          <span>{t('commander.handoffs.next', 'Next step')}</span>
          <Textarea
            rows={3}
            maxLength={HANDOFF_SECTION_LIMIT}
            value={draft.nextStep}
            onChange={(e) => setDraft({ ...draft, nextStep: e.target.value })}
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || Boolean(draft.goal.trim() && draft.progress.trim())}
          onClick={() => void capture()}
        >
          {t('commander.handoffs.capture', 'Use recent conversation')}
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {conflict && (
        <div role="alert" className="space-y-2 rounded-md border border-border p-3">
          {conflict.deleted
            ? t('commander.memory.staleDeleted', 'This page was deleted while you were editing.')
            : t('commander.memory.compare', 'Compare your draft with revision {{version}}.', {
                version: conflict.version
              })}
          <h3 className="break-words font-medium">{conflict.title}</h3>
          <pre className="whitespace-pre-wrap break-words font-sans">{conflict.body}</pre>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setBase(conflict)
              setConflict(null)
              setError('')
            }}
          >
            {conflict.deleted
              ? t('commander.memory.rebaseDeleted', 'Use my draft to restore this revision')
              : t('commander.memory.rebase', 'Keep my draft against this revision')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={
            busy ||
            !draft.goal.trim() ||
            !!conflict ||
            (!!page && !dirty && base?.version === page.version)
          }
          onClick={() => void save()}
        >
          {t('commander.memory.saveRevision', 'Save revision')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || discard}
          onClick={() => (dirty ? setDiscard(true) : onCancel())}
        >
          {t('commander.memory.cancel', 'Cancel')}
        </Button>
      </div>
      {discard && (
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t('commander.handoffs.discard', 'Discard unsaved changes?')}
        >
          <span>{t('commander.handoffs.discard', 'Discard unsaved changes?')}</span>
          <Button size="xs" disabled={busy} variant="outline" onClick={onCancel}>
            {t('commander.handoffs.discardAction', 'Discard changes')}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setDiscard(false)}>
            {t('commander.memory.cancel', 'Cancel')}
          </Button>
        </div>
      )}
    </section>
  )
}
