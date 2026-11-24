import { useState } from 'react'
import { Copy, ExternalLink, GitBranch, Play } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import {
  createPromptPipelineTask,
  type PipelineTask
} from '../../../../shared/pipeline/pipeline-task'
import type { WorkbenchTaskEntry } from './use-workbench-pipeline'

function sourceLabel(task: PipelineTask): string {
  if (task.source.kind === 'github_issue') {
    return `#${task.source.number}`
  }
  if (task.source.kind === 'linear_ticket') {
    return task.source.identifier
  }
  return 'Prompt'
}

function activeStageId(entry: WorkbenchTaskEntry): string {
  if (entry.run.completed) {
    return 'completed'
  }
  const active = Object.entries(entry.run.stages).find(([, status]) => status === 'active')
  return active?.[0] ?? 'idle'
}

export function WorkbenchDialoguePanel({
  entries,
  activeTaskId,
  hasRepo,
  onStartTask,
  onSelectTask,
  onDispatchEvent,
  onRunCheckGate,
  onRunReview,
  onRunCiWatch,
  onRunMerge,
  onOpenWorktree
}: {
  entries: readonly WorkbenchTaskEntry[]
  activeTaskId: string | null
  hasRepo: boolean
  onStartTask: (task: PipelineTask, options?: { requireApproval?: boolean }) => Promise<void>
  onSelectTask: (taskId: string) => void
  onDispatchEvent: (taskId: string, eventType: string) => void
  onRunCheckGate: (taskId: string) => Promise<void>
  onRunReview: (taskId: string) => Promise<void>
  onRunCiWatch: (taskId: string, prNumber: number) => Promise<void>
  onRunMerge: (taskId: string, prNumber: number) => Promise<void>
  onOpenWorktree: (worktreeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [prompt, setPrompt] = useState('')
  const [requireApproval, setRequireApproval] = useState(false)
  const [prNumberByTask, setPrNumberByTask] = useState<Record<string, string>>({})

  const submitPrompt = () => {
    const trimmed = prompt.trim()
    if (!trimmed) {
      return
    }
    const task = createPromptPipelineTask(trimmed)
    setPrompt('')
    void onStartTask(task, { requireApproval })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Card className="flex flex-col gap-2 p-3">
        <Textarea
          value={prompt}
          rows={3}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t(
            'auto.components.workbench.dialogue.placeholder',
            'Describe a task to run in an isolated worktree (Cmd/Ctrl+Enter to start)...'
          )}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              submitPrompt()
            }
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={requireApproval}
              onChange={(event) => setRequireApproval(event.target.checked)}
              className="rounded border"
            />
            {t('auto.components.workbench.dialogue.requireApproval', 'Require approval before fix')}
          </label>
          <div className="flex items-center gap-2">
            {!hasRepo ? (
              <span className="text-2xs text-muted-foreground">
                {t(
                  'auto.components.workbench.dialogue.noRepoHint',
                  'No active repo: will track pipeline without creating a worktree'
                )}
              </span>
            ) : null}
            <Button size="sm" disabled={!prompt.trim()} onClick={submitPrompt}>
              <Play className="size-3.5" />
              {t('auto.components.workbench.dialogue.start', 'Start Task')}
            </Button>
          </div>
        </div>
      </Card>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto scrollbar-sleek">
        {entries.length === 0 ? (
          <Card className="p-3 text-sm text-muted-foreground">
            {t(
              'auto.components.workbench.dialogue.empty',
              'Enter a task above or start one from the Board tab.'
            )}
          </Card>
        ) : (
          entries.map((entry) => {
            const stage = activeStageId(entry)
            const isSelected = entry.task.id === activeTaskId
            const prInput = prNumberByTask[entry.task.id] ?? ''
            const parsedPr = Number.parseInt(prInput, 10)
            const hasValidPr = Number.isFinite(parsedPr) && parsedPr > 0
            const busy = Boolean(entry.runningStage)

            return (
              <Card
                key={entry.task.id}
                className={`flex cursor-pointer flex-col gap-2 p-3 transition-colors ${
                  isSelected ? 'border-primary/60' : ''
                }`}
                onClick={() => onSelectTask(entry.task.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Badge variant="secondary" className="shrink-0 rounded-full">
                      {sourceLabel(entry.task)}
                    </Badge>
                    <span className="truncate text-sm font-medium">{entry.task.title}</span>
                  </div>
                  <Badge variant="outline" className="shrink-0 rounded-full">
                    {entry.runningStage
                      ? t('auto.components.workbench.dialogue.runningStage', 'running: {{stage}}', {
                          stage: entry.runningStage
                        })
                      : stage}
                  </Badge>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    {entry.creatingWorktree ? (
                      <span>
                        {t(
                          'auto.components.workbench.dialogue.creatingWorktree',
                          'Creating isolated worktree...'
                        )}
                      </span>
                    ) : entry.worktree ? (
                      <span className="flex items-center gap-1">
                        <GitBranch className="size-3.5" />
                        <span>{entry.worktree.branch ?? entry.worktree.displayName}</span>
                      </span>
                    ) : null}
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-1.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {stage === 'approval' ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => onDispatchEvent(entry.task.id, 'approved')}
                      >
                        {t('auto.components.workbench.dialogue.approve', 'Approve')}
                      </Button>
                    ) : null}
                    {stage === 'fix' && entry.worktree ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void onRunCheckGate(entry.task.id)}
                      >
                        {t('auto.components.workbench.dialogue.checkChanged', 'Run check:changed')}
                      </Button>
                    ) : null}
                    {stage === 'review' && entry.worktree ? (
                      <Button
                        size="xs"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void onRunReview(entry.task.id)}
                      >
                        {t('auto.components.workbench.dialogue.runReview', 'Run Review')}
                      </Button>
                    ) : null}
                    {(stage === 'ci' || stage === 'merge') && entry.worktree ? (
                      <>
                        <Input
                          value={prInput}
                          onChange={(e) =>
                            setPrNumberByTask((prev) => ({
                              ...prev,
                              [entry.task.id]: e.target.value
                            }))
                          }
                          placeholder={t(
                            'auto.components.workbench.dialogue.prNumberPlaceholder',
                            'PR #'
                          )}
                          className="h-6 w-20 text-xs"
                        />
                        {stage === 'ci' ? (
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={busy || !hasValidPr}
                            onClick={() => void onRunCiWatch(entry.task.id, parsedPr)}
                          >
                            {t('auto.components.workbench.dialogue.watchCi', 'Watch CI')}
                          </Button>
                        ) : (
                          <Button
                            size="xs"
                            variant="secondary"
                            disabled={busy || !hasValidPr}
                            onClick={() => void onRunMerge(entry.task.id, parsedPr)}
                          >
                            {t('auto.components.workbench.dialogue.mergePr', 'Merge PR')}
                          </Button>
                        )}
                      </>
                    ) : null}
                    {entry.reworkPrompt ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => void navigator.clipboard.writeText(entry.reworkPrompt!)}
                      >
                        <Copy className="size-3.5" />
                        {t('auto.components.workbench.dialogue.copyFeedback', 'Copy Feedback')}
                      </Button>
                    ) : null}
                    {entry.worktree ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => onOpenWorktree(entry.worktree!.id)}
                      >
                        <ExternalLink className="size-3.5" />
                        {t('auto.components.workbench.dialogue.openWorktree', 'Open Worktree')}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {entry.error ? <p className="text-xs text-destructive">{entry.error}</p> : null}
                {entry.lastOutput ? (
                  <pre className="max-h-28 overflow-y-auto rounded bg-muted p-2 text-2xs text-muted-foreground whitespace-pre-wrap scrollbar-sleek">
                    {entry.lastOutput}
                  </pre>
                ) : null}
              </Card>
            )
          })
        )}
      </div>
    </div>
  )
}
