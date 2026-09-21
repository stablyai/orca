import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { coordinatorPrompt, launchProjectCoordinator } from './project-coordinator-launch'

export function ProjectCoordinatorLauncher({
  repo,
  target,
  goal,
  instructions,
  dirty
}: {
  repo: Repo
  target: RuntimeClientTarget
  goal: string
  instructions: string
  dirty: boolean
}) {
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const disabled = useAppStore((state) => state.settings?.disabledTuiAgents)
  const [worktreeId, setWorktreeId] = useState('')
  const [agentId, setAgentId] = useState('')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    const active = new AbortController()
    controller.current = active
    return () => active.abort()
  }, [])
  const [error, setError] = useState('')
  const owner = target.kind === 'environment' ? target.environmentId : null
  const worktrees = Object.values(worktreesByRepo)
    .flat()
    .filter(
      (worktree) =>
        worktree.repoId === repo.id &&
        getExecutionHostIdForWorktree(useAppStore.getState(), worktree.id) ===
          getRepoExecutionHostId(repo) &&
        getRuntimeEnvironmentIdForWorktree(useAppStore.getState(), worktree.id) === owner
    )
  const selectedWorktreeId =
    worktrees.find((worktree) => worktree.id === worktreeId)?.id ?? worktrees[0]?.id ?? ''
  const detectionTarget = useAgentDetectionTargetForWorktree(selectedWorktreeId)
  const detected = useDetectedAgents(selectedWorktreeId ? detectionTarget : undefined)
  const agents = filterEnabledTuiAgents(detected.detectedIds ?? [], disabled)
  const agent = agents.find((entry) => entry === agentId) ?? agents[0]
  const prompt = coordinatorPrompt(goal, instructions)
  async function launch() {
    if (
      !controller.current ||
      dirty ||
      locked.current ||
      !agent ||
      !selectedWorktreeId ||
      !goal.trim()
    ) {
      return
    }
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await launchProjectCoordinator({
        target,
        repoId: repo.id,
        executionHostId: getRepoExecutionHostId(repo),
        signal: controller.current.signal,
        worktreeId: selectedWorktreeId,
        agent,
        prompt
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <section
      className="min-w-0 space-y-3"
      aria-label={translate('projectHome.coordinator', 'Coordinator')}
    >
      <h2 className="text-base font-medium">
        {translate('projectHome.coordinator', 'Coordinator')}
      </h2>
      <p className="text-sm text-muted-foreground">
        {translate(
          'projectHome.launchHelp',
          'Open a new agent with a draft of your saved goal and instructions. Review and send the draft to begin a run.'
        )}
      </p>
      {dirty || !goal.trim() ? (
        <p role="status" className="text-sm text-muted-foreground">
          {translate(
            'projectHome.saveBeforeLaunch',
            'Save your goal and instructions before opening a coordinator. Unsaved drafts are kept while you navigate within Orca.'
          )}
        </p>
      ) : null}
      <Label htmlFor="project-workspace">{translate('projectHome.workspace', 'Workspace')}</Label>
      <Select
        value={selectedWorktreeId}
        onValueChange={setWorktreeId}
        disabled={busy || !worktrees.length}
      >
        <SelectTrigger id="project-workspace" className="w-full">
          <SelectValue
            placeholder={translate(
              'projectHome.noWorkspace',
              'Open a workspace in this project first'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {worktrees.map((worktree) => (
            <SelectItem key={worktree.id} value={worktree.id}>
              {worktree.branch || worktree.path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Label htmlFor="project-agent">{translate('projectHome.agent', 'Agent')}</Label>
      <Select
        value={agent ?? ''}
        onValueChange={setAgentId}
        disabled={dirty || busy || !agents.length}
      >
        <SelectTrigger id="project-agent" className="w-full">
          <SelectValue
            placeholder={translate('projectHome.noAgent', 'No enabled agents detected')}
          />
        </SelectTrigger>
        <SelectContent>
          {agents.map((entry) => (
            <SelectItem key={entry} value={entry}>
              {entry}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <details>
        <summary className="cursor-pointer text-sm">
          {translate('projectHome.preview', 'Preview coordinator draft')}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {prompt}
        </pre>
      </details>
      <Button
        onClick={() => void launch()}
        disabled={dirty || busy || !agent || !selectedWorktreeId || !goal.trim()}
      >
        {busy
          ? translate('projectHome.opening', 'Opening…')
          : translate('projectHome.launch', 'Open coordinator draft')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  )
}
