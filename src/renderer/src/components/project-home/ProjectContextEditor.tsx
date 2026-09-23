import { useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { loadProject, saveProject, type ProjectContext } from './project-home-api'

export function ProjectContextEditor({
  project,
  target,
  repoId,
  draftKey,
  onSaved
}: {
  project: ProjectContext
  target: RuntimeClientTarget
  repoId: string
  draftKey: string
  onSaved: (project: ProjectContext) => void
}) {
  const [base, setBase] = useState(project)
  const draft = useAppStore((state) => state.projectHomeDrafts[draftKey])
  const goal = draft?.goal ?? base.coordination?.goal ?? ''
  const instructions = draft?.instructions ?? base.coordination?.instructions ?? ''
  function edit(nextGoal: string, nextInstructions: string) {
    useAppStore.getState().setProjectHomeDraft(draftKey, {
      goal: nextGoal,
      instructions: nextInstructions,
      expectedRevision: draft?.expectedRevision ?? base.coordination?.revision ?? 0
    })
  }
  const [showSaved, setShowSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  async function save() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await saveProject(
        target,
        base,
        goal,
        instructions,
        draft?.expectedRevision ?? base.coordination?.revision ?? 0
      )
      setBase(updated)
      onSaved(updated)
      if (useAppStore.getState().projectHomeDrafts[draftKey] === draft) {
        useAppStore.getState().setProjectHomeDraft(draftKey, null)
      }
      setNotice(translate('projectHome.saved', 'Saved.'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  async function reload() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await loadProject(target, repoId)
      setBase(updated)
      onSaved(updated)
      if (draft && useAppStore.getState().projectHomeDrafts[draftKey] === draft) {
        useAppStore.getState().setProjectHomeDraft(draftKey, {
          goal,
          instructions,
          expectedRevision: updated.coordination?.revision ?? 0
        })
      }
      setShowSaved(true)
      // Preserve the user's draft; a fresh revision allows an explicit, reviewed retry.
      setNotice(
        draft
          ? translate(
              'projectHome.reloaded',
              'Latest saved context loaded below. Your draft is preserved; compare it before saving again.'
            )
          : translate('projectHome.loadedLatest', 'Loaded latest saved context.')
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="text-base font-medium">
        {translate('projectHome.context', 'Project context')}
      </h2>
      <Label htmlFor="project-goal">{translate('projectHome.goal', 'Goal')}</Label>
      <Textarea
        id="project-goal"
        value={goal}
        maxLength={4000}
        disabled={busy}
        onChange={(event) => edit(event.target.value, instructions)}
        placeholder={translate(
          'projectHome.goalPlaceholder',
          'What should this project accomplish?'
        )}
      />
      <Label htmlFor="project-instructions">
        {translate('projectHome.instructions', 'Instructions')}
      </Label>
      <Textarea
        id="project-instructions"
        rows={6}
        value={instructions}
        maxLength={16000}
        disabled={busy}
        onChange={(event) => edit(goal, event.target.value)}
        placeholder={translate(
          'projectHome.instructionsPlaceholder',
          'Conventions, constraints, and context for the coordinator'
        )}
      />
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void save()}>
          {translate('projectHome.save', 'Save context')}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void reload()}>
          {translate('projectHome.loadLatest', 'Load latest saved context')}
        </Button>
        {draft ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              useAppStore.getState().setProjectHomeDraft(draftKey, null)
              setNotice('')
              setError('')
            }}
          >
            {translate('projectHome.discardDraft', 'Discard draft')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      <details open={showSaved} onToggle={(event) => setShowSaved(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm">
          {translate('projectHome.savedContext', 'Saved context used for new coordinators')}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {base.coordination?.goal}
          {'\n\n'}
          {base.coordination?.instructions}
        </pre>
      </details>
    </section>
  )
}
