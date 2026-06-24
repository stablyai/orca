import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import { getComposerEligibleRepos } from '@/lib/new-workspace-composer-repo'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import { launchOrchestratorForProject } from '@/lib/orchestrator-launch'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/types'

// Why: mirrors the "Create worktree" composer (same Dialog + ProjectCombobox +
// AgentCombobox) so launching an Orcastrator feels native. Adds a Name and a
// task prompt — the prompt is seeded after `/orcastrate` so the director starts
// planning the work instead of asking for it.
// Why: a "Send to Orcastrator" action on a tracked issue opens this modal
// prefilled — pre-selecting the project when the issue is repo-bound and seeding
// the issue as the director's task. See lib/send-work-item-to-orchestrator.ts.
type OrchestratorLaunchPrefill = {
  prefillName?: string
  prefillPrompt?: string
  prefillProjectId?: string | null
}

export default function OrchestratorLaunchModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'orchestrator-launch')
  const prefill = useAppStore((s) =>
    s.activeModal === 'orchestrator-launch'
      ? (s.modalData as OrchestratorLaunchPrefill | undefined)
      : undefined
  )
  const closeModal = useAppStore((s) => s.closeModal)
  const projects = useAppStore((s) => s.projects)
  const repos = useAppStore((s) => s.repos)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const disabledTuiAgents = useAppStore((s) => s.settings?.disabledTuiAgents)
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)

  const nameId = useId()
  const promptId = useId()
  const nameInputRef = useRef<HTMLInputElement>(null)

  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceCreateTargetOptions({
        projects,
        projectHostSetups,
        eligibleRepos: getComposerEligibleRepos(repos),
        projectGroups
      }),
    [projects, projectHostSetups, repos, projectGroups]
  )
  const agents = useMemo(() => {
    const catalog = getAgentCatalog()
    const enabled = new Set(
      filterEnabledTuiAgents(
        catalog.map((a) => a.id),
        disabledTuiAgents
      )
    )
    const detected = detectedAgentIds ? new Set(detectedAgentIds) : null
    return catalog.filter((a) => enabled.has(a.id) && (detected === null || detected.has(a.id)))
  }, [disabledTuiAgents, detectedAgentIds])

  const firstProjectOptionId =
    projectOptions.find((option) => option.kind === 'project')?.id ?? null
  const prefillProjectId = prefill?.prefillProjectId ?? null
  const prefillName = prefill?.prefillName ?? ''
  const prefillPrompt = prefill?.prefillPrompt ?? ''
  const prefilledProjectOptionId = useMemo(
    () =>
      prefillProjectId
        ? (projectOptions.find(
            (option) => option.kind === 'project' && option.projectId === prefillProjectId
          )?.id ?? null)
        : null,
    [projectOptions, prefillProjectId]
  )
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [agent, setAgent] = useState<TuiAgent | null>(null)
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (visible) {
      setSelectedOptionId(prefilledProjectOptionId ?? firstProjectOptionId)
      setAgent(defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null)
      setName(prefillName)
      setPrompt(prefillPrompt)
    }
  }, [
    visible,
    firstProjectOptionId,
    prefilledProjectOptionId,
    defaultTuiAgent,
    prefillName,
    prefillPrompt
  ])

  if (!visible) {
    return null
  }

  const selectedOption = projectOptions.find((option) => option.id === selectedOptionId)
  const project =
    selectedOption?.kind === 'project'
      ? (projects.find((p) => p.id === selectedOption.projectId) ?? null)
      : null

  const handleLaunch = (): void => {
    if (!project) {
      return
    }
    void launchOrchestratorForProject(project, {
      name: name.trim() || undefined,
      agent: agent ?? undefined,
      prompt: prompt.trim() || undefined
    })
    closeModal()
  }

  return (
    <Dialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) {
          closeModal()
        }
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          // Why: Radix focuses the close button by default; land on the Name
          // field instead so the user can type/refine immediately (matches the
          // Create-worktree composer's open-focus behavior).
          event.preventDefault()
          nameInputRef.current?.focus()
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {translate('auto.components.OrchestratorLaunchModal.title', 'New Orcastrator')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.OrchestratorLaunchModal.description',
              'A director plans the work and runs agents in worktrees for you — it directs, it does not write the code itself.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            handleLaunch()
          }}
        >
          <div className="space-y-2">
            <Label className="text-xs">
              {translate('auto.components.OrchestratorLaunchModal.project', 'Project')}
            </Label>
            <ProjectCombobox
              options={projectOptions}
              value={selectedOptionId}
              onValueChange={setSelectedOptionId}
              placeholder={translate(
                'auto.components.OrchestratorLaunchModal.pick_project',
                'Select a project'
              )}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={nameId} className="text-xs">
              {translate('auto.components.OrchestratorLaunchModal.name', 'Name')}
            </Label>
            <Input
              id={nameId}
              ref={nameInputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                project?.displayName ??
                translate('auto.components.OrchestratorLaunchModal.name_placeholder', 'Orcastrator')
              }
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              {translate('auto.components.OrchestratorLaunchModal.agent', 'Agent')}
            </Label>
            <AgentCombobox agents={agents} value={agent} onValueChange={setAgent} />
          </div>
          <div className="space-y-2">
            <Label htmlFor={promptId} className="text-xs">
              {translate(
                'auto.components.OrchestratorLaunchModal.task',
                'What should it orchestrate?'
              )}
            </Label>
            <textarea
              id={promptId}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
              placeholder={translate(
                'auto.components.OrchestratorLaunchModal.task_placeholder',
                'Describe the work — the director plans how to split it into worktrees/PRs. Optional.'
              )}
              className="flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeModal}>
              {translate('auto.components.OrchestratorLaunchModal.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!project}>
              {translate('auto.components.OrchestratorLaunchModal.launch', 'Launch Orcastrator')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
