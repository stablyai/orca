import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { useState } from 'react'
import { toast } from 'sonner'
import { LoaderCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ImeTextarea } from '@/lib/ime-text-field'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { giteaApiFor } from '@/runtime/gitea-owner-api'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { GiteaWorkItem } from '../../../../../shared/gitea-types'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'

export function TaskPageGiteaIssueDialog({
  model,
  open,
  onOpenChange
}: {
  model: TaskPageComposerActionsModel
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { selectedRepos, setGiteaRefreshNonce, openGiteaDetailPage } = model
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [repoId, setRepoId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Why: fall back to the first selected repo if the chosen id drops from the selection mid-dialog, so submit always has a target.
  const targetRepo = selectedRepos.find((r) => r.id === repoId) ?? selectedRepos[0] ?? null

  const handleCreate = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!targetRepo || !trimmedTitle || submitting) {
      return
    }
    setSubmitting(true)
    try {
      const selector = {
        repoPath: targetRepo.path,
        repoId: targetRepo.id,
        sourceContext: getTaskPageRepoSourceContext(targetRepo, 'gitea'),
        repoOwnerExecutionHostId: getRepoExecutionHostId(targetRepo)
      }
      const result = await giteaApiFor(selector).createIssue({
        ...selector,
        title: trimmedTitle,
        body
      })
      if (!result.ok) {
        toast.error(
          result.error ||
            translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
        )
        return
      }
      useAppStore.getState().recordFeatureInteraction('gitea-tasks')
      toast.success(
        translate('auto.components.TaskPage.3f9604efc7', 'Opened issue #{{value0}}', {
          value0: result.number
        }),
        {
          action: result.url
            ? {
                label: translate('auto.components.TaskPage.9c57663908', 'View'),
                onClick: () => void window.api.shell.openUrl(result.url)
              }
            : undefined
        }
      )
      setTitle('')
      setBody('')
      onOpenChange(false)
      setGiteaRefreshNonce((n) => n + 1)
      const created: GiteaWorkItem = {
        id: `issue:${result.number}`,
        type: 'issue',
        number: result.number,
        title: trimmedTitle,
        state: 'open',
        url: result.url,
        labels: [],
        updatedAt: new Date().toISOString(),
        author: null,
        repoId: targetRepo.id,
        repoHostId: getRepoExecutionHostId(targetRepo)
      }
      openGiteaDetailPage(created)
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.components.TaskPage.7437e340b4', 'Failed to create issue.')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) {
          onOpenChange(next)
        }
      }}
    >
      <DialogContent
        className="sm:max-w-xl"
        onKeyDown={(event) => {
          if (isScreenSubmitShortcut(event)) {
            event.preventDefault()
            void handleCreate()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.TaskPage.giteaNewIssueTitle', 'New Gitea issue')}
          </DialogTitle>
          <DialogDescription>
            {targetRepo
              ? translate('auto.components.TaskPage.filingInTarget', 'Filing in {{target}}', {
                  target: targetRepo.displayName
                })
              : translate(
                  'auto.components.TaskPage.filingInThisRepository',
                  'Filing in this repository'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {selectedRepos.length > 1 ? (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                {translate('auto.components.TaskPage.00022ec0ba', 'Project')}
              </label>
              <Select value={targetRepo?.id} onValueChange={setRepoId} disabled={submitting}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedRepos.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      <RepoBadgeLabel name={r.displayName} color={r.badgeColor} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.16cba35bee', 'Title')}
            </label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
              placeholder={translate('auto.components.TaskPage.578f730c16', 'Short summary')}
              disabled={submitting}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {translate('auto.components.TaskPage.7f3f7b4c18', 'Description (optional, markdown)')}
            </label>
            <ImeTextarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={translate('auto.components.TaskPage.34d97ca682', "What's going on?")}
              disabled={submitting}
              rows={6}
              className="min-h-40 w-full resize-y rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm shadow-xs focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/50"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleCreate()}
            disabled={!targetRepo || !title.trim() || submitting}
          >
            {submitting ? (
              <>
                <LoaderCircle className="size-4 animate-spin" />
                {translate('auto.components.TaskPage.8ff6fdc368', 'Creating…')}
              </>
            ) : (
              translate('auto.components.TaskPage.e15ba2d2eb', 'Create issue')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
