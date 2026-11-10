import React, { useMemo, useState } from 'react'
import { Loader2, Play } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { WorkflowPreset } from '../../../../shared/workflow/workflow-definition-schema'
import { isWorkflowAgentNode } from '../../../../shared/workflow/workflow-definition-schema'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { workflowRpc } from './workflow-rpc'
import { runWhilePending } from './workflow-pending-action'
import { useWorkflowEditorStore } from './workflow-editor-store'
import { useWorkflowRunViewStore } from './workflow-run-view-store'
import { useTranslate } from '@/i18n/use-translate'

type WorkspaceOption = { id: string; label: string; folder: boolean }

function useWorkspaceOptions(): WorkspaceOption[] {
  const t = useTranslate()
  const worktreesByRepo = useAppStore(selectWorktreesByRepo)
  const folders = useAppStore(selectFolderWorkspaces)
  const repos = useAppStore((state) => state.repos)
  return useMemo(() => {
    // Folder projects list their workspace among worktrees too, and they cannot create worktrees.
    const folderRepoIds = new Set(repos.filter(isFolderRepo).map((repo) => repo.id))
    const worktrees = Object.entries(worktreesByRepo ?? {}).flatMap(([repoId, rows]) =>
      rows
        .filter((worktree) => !worktree.isArchived)
        .map((worktree) => ({
          id: worktree.id,
          label: worktree.displayName || worktree.id,
          folder: folderRepoIds.has(repoId)
        }))
    )
    const folderOptions = (folders ?? []).map((folder) => ({
      id: folder.id,
      label: t('auto.components.workflows.WorkflowRunDialog.a28bc6ce92', '{{value0}} (folder)', {
        value0: folder.name
      }),
      folder: true
    }))
    return [...worktrees, ...folderOptions]
  }, [worktreesByRepo, folders, repos, t])
}

export function WorkflowRunDialog({
  preset,
  open,
  onOpenChange
}: {
  preset: WorkflowPreset
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const options = useWorkspaceOptions()
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const [objective, setObjective] = useState(preset.defaultRunSettings.objective)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const setIssues = useWorkflowEditorStore((state) => state.setIssues)
  const setMode = useWorkflowEditorStore((state) => state.setMode)
  const watch = useWorkflowRunViewStore((state) => state.watch)
  const chosen =
    workspaceId ??
    options.find((option) => option.id === activeWorktreeId)?.id ??
    options[0]?.id ??
    null
  const chosenOption = options.find((option) => option.id === chosen)
  const needsGit = preset.definition.nodes.some(
    (node) => isWorkflowAgentNode(node) && node.agent.placement.worktree !== 'current'
  )
  const folderBlocksIsolation = Boolean(chosenOption?.folder && needsGit)

  const start = async (): Promise<void> => {
    if (!chosenOption) {
      return
    }
    const target = tryRuntimeTargetForWorktreeOwner(useAppStore.getState(), chosenOption.id)
    if (!target) {
      toast.error(
        t(
          'auto.components.workflows.WorkflowRunDialog.8735ec6aca',
          'Orca could not tell which host owns that workspace.'
        )
      )
      return
    }
    await runWhilePending(setStarting, async () => {
      try {
        const result = await workflowRpc.startRun(target, {
          preset,
          objective,
          worktreeSelector: `id:${chosenOption.id}`,
          worktreeLabel: chosenOption.label
        })
        if (!result.run) {
          setIssues(result.issues)
          toast.error(
            t(
              'auto.components.workflows.WorkflowRunDialog.05e98d142b',
              'The workflow has validation errors'
            ),
            {
              description: result.issues[0]?.message
            }
          )
          return
        }
        watch(target, result.run.id)
        setMode('execution')
        onOpenChange(false)
      } catch (error) {
        toast.error(
          t('auto.components.workflows.WorkflowRunDialog.e40b033de5', 'Could not start the run'),
          {
            description: error instanceof Error ? error.message : String(error)
          }
        )
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.workflows.WorkflowRunDialog.c311106a6e', 'Run')}
            {preset.name}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.workflows.WorkflowRunDialog.f953f13727',
              'Orca opens a coordinator terminal in the workspace, creates a Run, and starts each agent as a real worker when its turn comes. The run uses a frozen copy of this workflow.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="workflow-run-objective" variant="field">
              {t('auto.components.workflows.WorkflowRunDialog.37f0cece8d', 'Objective')}
            </Label>
            <Textarea
              id="workflow-run-objective"
              autoFocus
              rows={4}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-run-workspace" variant="field">
              {t('auto.components.workflows.WorkflowRunDialog.494287c71a', 'Workspace')}
            </Label>
            <Select value={chosen ?? undefined} onValueChange={setWorkspaceId}>
              <SelectTrigger id="workflow-run-workspace" className="w-full">
                <SelectValue
                  placeholder={t(
                    'auto.components.workflows.WorkflowRunDialog.7ea393f34c',
                    'No workspaces'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {t(
                'auto.components.workflows.WorkflowRunDialog.81554cce16',
                'Agents set to the shared workspace work here; isolated agents get their own worktrees beside it.'
              )}
            </p>
            {folderBlocksIsolation ? (
              <p role="alert" className="text-xs text-destructive">
                {t(
                  'auto.components.workflows.WorkflowRunDialog.3f1c9a7e52',
                  'Folder projects cannot create worktrees. Pick a workspace from a Git project, or set every agent to the shared workspace.'
                )}
              </p>
            ) : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('auto.components.workflows.WorkflowRunDialog.f4c667feb5', 'Cancel')}
          </Button>
          <Button
            onClick={() => void start()}
            disabled={starting || !chosenOption || !objective.trim() || folderBlocksIsolation}
          >
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {t('auto.components.workflows.WorkflowRunDialog.ed282070ff', 'Start run')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
