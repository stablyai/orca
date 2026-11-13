import { useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon } from './icons/AgentIcon'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { useAgentMenuObservation } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { projectForAgentDefault } from './project-agent-default'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { workspaceKindForWorktreeId } from '../../../../shared/agent-launch/contracts/workspace-launch-kind'
import {
  agentPickerDraft,
  agentPickerEffectiveChoices
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { ProjectAgentLaunchDefault } from '../../../../shared/agent-launch/project-agent-launch-default'
import { normalizeAgentModelOptionChoices } from '../../../../shared/agent-launch/choices/agent-launch-choices'
import type { Repo } from '../../../../shared/repo-types'
import type { Project } from '../../../../shared/project-types'

export function ProjectDefaultAgentMenuItem({ repo }: { repo: Repo }): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const project = useAppStore((state) => projectForAgentDefault(state, repo))
  const choice = project?.agentLaunchDefault
  return (
    <DropdownMenuSub open={open} onOpenChange={setOpen}>
      <DropdownMenuSubTrigger disabled={!project}>
        {choice ? <AgentIcon agent={choice.agent} size={14} /> : <Sparkles className="size-3.5" />}
        <span className="flex-1">{t('sidebar.projectDefault.title', 'Default AI')}</span>
        {choice ? (
          <span className="text-2xs text-muted-foreground">{getAgentLabel(choice.agent)}</span>
        ) : null}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-72">
        {open && project ? (
          <ProjectDefaultAgentPicker repo={repo} project={project} onSaved={() => setOpen(false)} />
        ) : null}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function ProjectDefaultAgentPicker({
  repo,
  project,
  onSaved
}: {
  repo: Repo
  project: Project
  onSaved: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [pending, setPending] = useState(false)
  const hostId = getRepoExecutionHostId(repo)
  const worktreeId = useAppStore((state) => {
    const worktrees = (selectWorktreesByRepo(state)[repo.id] ?? []).filter(
      (row) => getWorktreeExecutionHostId(row, repo) === hostId
    )
    const worktree = worktrees.find((row) => row.isMainWorktree) ?? worktrees[0]
    if (worktree) {
      return worktree.id
    }
    const folder = selectFolderWorkspaces(state).find(
      (row) => row.folderPath === repo.path && getRepoExecutionHostId(row) === hostId
    )
    return folder ? folderWorkspaceKey(folder.id) : null
  })
  const knownTarget = useAgentDetectionTargetForWorktree(worktreeId, hostId)
  const detection = useMemo<AgentDetectionTarget | undefined>(() => {
    if (worktreeId) {
      return knownTarget
    }
    const host = parseExecutionHostId(hostId)
    if (host?.kind === 'runtime') {
      return { kind: 'runtime', environmentId: host.environmentId }
    }
    if (host?.kind === 'ssh') {
      return { kind: 'ssh', connectionId: host.targetId }
    }
    return { kind: 'local' }
  }, [hostId, worktreeId, knownTarget])
  const target = useMemo(
    () => ({
      workspace: {
        kind: worktreeId
          ? workspaceKindForWorktreeId(worktreeId)
          : repo.kind === 'folder'
            ? ('folder' as const)
            : ('git-worktree' as const),
        repoId: repo.id,
        ...(worktreeId ? { worktreeId, hostId } : { executionHostId: hostId })
      }
    }),
    [worktreeId, repo.id, repo.kind, hostId]
  )
  const { model } = useAgentMenuObservation(target, true, detection, { wakeOnOpen: true })
  const entries = useAgentLaunchPickerInventory(worktreeId ?? undefined, model, true)
  const updateProject = useAppStore((state) => state.updateProject)
  const choice = project.agentLaunchDefault
  const failSave = (): false => {
    toast.error(t('sidebar.projectDefault.saveFailed', 'Could not save the project default AI.'))
    return false
  }
  const save = async (next: ProjectAgentLaunchDefault | null): Promise<boolean> => {
    if (pending) {
      return false
    }
    setPending(true)
    return updateProject(project.id, { agentLaunchDefault: next }, hostId)
      .then((saved) => {
        if (!saved) {
          return failSave()
        }
        onSaved()
        return true
      })
      .catch(failSave)
      .finally(() => setPending(false))
  }
  return (
    <>
      <AgentLaunchPickerMenu
        model={model}
        entries={entries}
        mode="select"
        disabled={pending}
        value={choice ? { ...choice, prompt: '' } : undefined}
        runLaunch={(row, draft, entry, surface) => {
          const selectedEntry = entry ?? entries.find((candidate) => candidate.agent === row.agent)
          const selectedDraft =
            draft ?? (selectedEntry ? agentPickerDraft(selectedEntry) : undefined)
          return save({
            agent: row.agent,
            surface:
              surface ?? selectedDraft?.surface ?? (row.kind === 'chat' ? 'chat' : 'terminal'),
            choices:
              normalizeAgentModelOptionChoices(
                selectedEntry && selectedDraft
                  ? agentPickerEffectiveChoices(selectedEntry, selectedDraft)
                  : {}
              ) ?? {}
          })
        }}
      />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!choice || pending}
        onSelect={(event) => {
          event.preventDefault()
          void save(null)
        }}
      >
        {t('sidebar.projectDefault.clear', 'Clear project default')}
      </DropdownMenuItem>
    </>
  )
}
