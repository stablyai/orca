import React, { useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { isMissionEligibleRepo, slugifyMissionBranch } from '../../../../shared/missions'
import { formatMissionMemberError } from './mission-member-error-copy'
import { MissionGroupQuickAdd } from './MissionGroupQuickAdd'
import type { MissionMemberResult } from '../../../../shared/types'

export type MissionCreateMemberStatus = {
  repoId: string
  repoName: string
  state: 'pending' | 'created' | 'failed'
  error?: string
}

export function MissionCreateMemberStatusList({
  entries
}: {
  entries: MissionCreateMemberStatus[]
}): React.JSX.Element {
  return (
    <ul className="max-h-48 space-y-1.5 overflow-y-auto scrollbar-sleek">
      {entries.map((entry) => (
        <li key={entry.repoId} className="flex items-start gap-2 text-xs">
          {entry.state === 'pending' ? (
            <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : entry.state === 'created' ? (
            <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-foreground">{entry.repoName}</span>
            {entry.error ? (
              <span className="break-words text-[11px] text-destructive">{entry.error}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function MissionCreateDialog(): React.JSX.Element {
  const open = useAppStore((s) => s.activeModal === 'mission-create')
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const createMission = useAppStore((s) => s.createMission)
  const setSidebarListMode = useAppStore((s) => s.setSidebarListMode)

  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const disabledTuiAgents = useAppStore((s) => s.settings?.disabledTuiAgents ?? [])
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)

  const nameId = useId()
  const branchId = useId()
  const baseBranchId = useId()
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  const branchDirtyRef = useRef(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [sessionAgent, setSessionAgent] = useState<TuiAgent | null>(() =>
    isTuiAgent(defaultTuiAgent) ? defaultTuiAgent : null
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [baseBranch, setBaseBranch] = useState('')
  const [setupDecision, setSetupDecision] = useState<'run' | 'skip' | 'inherit'>('inherit')
  const [submitting, setSubmitting] = useState(false)
  const [memberResults, setMemberResults] = useState<MissionMemberResult[] | null>(null)

  const visibleAgents = useMemo(() => {
    const enabledIds = new Set(
      filterEnabledTuiAgents(
        getAgentCatalog().map((agent) => agent.id),
        disabledTuiAgents
      )
    )
    const detected = detectedAgentIds === null ? null : new Set(detectedAgentIds)
    return getAgentCatalog().filter(
      (agent) => enabledIds.has(agent.id) && (detected === null || detected.has(agent.id))
    )
  }, [detectedAgentIds, disabledTuiAgents])

  const eligibleRepos = useMemo(() => repos.filter(isMissionEligibleRepo), [repos])
  const repoNameById = useMemo(
    () => new Map(eligibleRepos.map((repo) => [repo.id, repo.displayName])),
    [eligibleRepos]
  )
  const effectiveBranch =
    branchDirtyRef.current && branch.trim() ? branch.trim() : slugifyMissionBranch(name)
  const selectedIds = useMemo(() => [...selected], [selected])
  const canSubmit = name.trim().length > 0 && selectedIds.length > 0 && !submitting

  const statusEntries: MissionCreateMemberStatus[] = memberResults
    ? memberResults.map((result) => ({
        repoId: result.repoId,
        repoName: repoNameById.get(result.repoId) ?? result.repoId,
        state: result.error ? 'failed' : 'created',
        error: result.error ? formatMissionMemberError(result.error) : undefined
      }))
    : selectedIds.map((repoId) => ({
        repoId,
        repoName: repoNameById.get(repoId) ?? repoId,
        state: 'pending'
      }))
  const showStatusList = submitting || memberResults !== null

  function resetAndClose(): void {
    setName('')
    setBranch('')
    branchDirtyRef.current = false
    setSelected(new Set())
    setSubmitting(false)
    setMemberResults(null)
    closeModal()
  }

  function finishIntoMissionsTab(): void {
    // Why: creation lands in the Missions tab even when triggered elsewhere,
    // so the user sees the created mission (and any failed members) in place.
    setSidebarListMode('missions')
    resetAndClose()
  }

  async function handleSubmit(event?: React.FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault()
    if (!canSubmit || memberResults !== null) {
      return
    }
    setSubmitting(true)
    const trimmedBaseBranch = baseBranch.trim()
    const result = await createMission({
      name: name.trim(),
      branchName: effectiveBranch,
      repoIds: selectedIds,
      ...(trimmedBaseBranch ? { baseBranch: trimmedBaseBranch } : {}),
      ...(setupDecision !== 'inherit' ? { setupDecision } : {}),
      ...(sessionAgent ? { sessionAgent } : {})
    })
    if (!result) {
      setSubmitting(false)
      return
    }
    if (result.memberResults.every((entry) => !entry.error)) {
      finishIntoMissionsTab()
      return
    }
    // Why (spec §6): partial failures stay visible in the dialog so the user
    // acknowledges them instead of hunting for silently missing workspaces.
    setMemberResults(result.memberResults)
    setSubmitting(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || submitting) {
          return
        }
        if (memberResults !== null) {
          finishIntoMissionsTab()
          return
        }
        resetAndClose()
      }}
    >
      <DialogContent className="max-w-sm sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.MissionCreateDialog.0655a02f86', 'New Mission')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.sidebar.MissionCreateDialog.4608f14ade',
              'Each selected project gets a workspace on a shared mission branch.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          {showStatusList ? (
            <div className="space-y-2">
              <MissionCreateMemberStatusList entries={statusEntries} />
              {memberResults !== null ? (
                <p className="text-xs text-destructive">
                  {translate(
                    'auto.components.sidebar.MissionCreateDialog.507155ae18',
                    'Some workspaces could not be created. You can retry from the mission list.'
                  )}
                </p>
              ) : null}
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor={nameId} className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.MissionCreateDialog.48ec5c5b11',
                    'Mission Name'
                  )}
                </Label>
                <Input
                  id={nameId}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={branchId} className="text-[11px] text-muted-foreground">
                  {translate('auto.components.sidebar.MissionCreateDialog.0c9fe9ce6d', 'Branch')}
                </Label>
                <Input
                  id={branchId}
                  value={branchDirtyRef.current ? branch : effectiveBranch}
                  onChange={(event) => {
                    branchDirtyRef.current = true
                    setBranch(event.target.value)
                  }}
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label className="text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.sidebar.MissionCreateDialog.bcea32d392',
                      'Projects'
                    )}
                  </Label>
                  <MissionGroupQuickAdd
                    onAdd={(repoIds) => setSelected(new Set([...selected, ...repoIds]))}
                  />
                </div>
                <RepoMultiCombobox
                  repos={eligibleRepos}
                  selected={selected}
                  onChange={setSelected}
                  onSelectAll={() => setSelected(new Set(eligibleRepos.map((repo) => repo.id)))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">
                  {translate('auto.components.sidebar.MissionCreateDialog.ba57f70473', 'Agent')}
                </Label>
                <AgentCombobox
                  agents={visibleAgents}
                  value={sessionAgent}
                  onValueChange={setSessionAgent}
                  triggerClassName="h-8 w-full border-input text-xs"
                />
              </div>
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdvancedOpen((open) => !open)}
                  className="-ml-2 h-6 text-[11px] text-muted-foreground"
                >
                  {translate('auto.components.sidebar.MissionCreateDialog.c43b33e4ef', 'Advanced')}
                  <ChevronDown
                    className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
                  />
                </Button>
                {advancedOpen ? (
                  <div className="mt-2 space-y-4">
                    <div className="space-y-1">
                      <Label htmlFor={baseBranchId} className="text-[11px] text-muted-foreground">
                        {translate(
                          'auto.components.sidebar.MissionCreateDialog.603415390c',
                          'Base branch'
                        )}
                      </Label>
                      <Input
                        id={baseBranchId}
                        value={baseBranch}
                        onChange={(event) => setBaseBranch(event.target.value)}
                        className="h-8 font-mono text-xs"
                      />
                      <p className="text-[11px] text-muted-foreground/70">
                        {translate(
                          'auto.components.sidebar.MissionCreateDialog.9b2b02c9ee',
                          "Leave empty to branch from each project's default branch."
                        )}
                      </p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[11px] text-muted-foreground">
                        {translate(
                          'auto.components.sidebar.MissionCreateDialog.c9ffbca654',
                          'Setup scripts'
                        )}
                      </Label>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={setupDecision === 'inherit' ? 'secondary' : 'outline'}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setSetupDecision('inherit')}
                        >
                          {translate(
                            'auto.components.sidebar.MissionCreateDialog.f3cd8cdbd7',
                            'Inherit'
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={setupDecision === 'run' ? 'secondary' : 'outline'}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setSetupDecision('run')}
                        >
                          {translate(
                            'auto.components.sidebar.MissionCreateDialog.f89f5bad98',
                            'Run'
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={setupDecision === 'skip' ? 'secondary' : 'outline'}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setSetupDecision('skip')}
                        >
                          {translate(
                            'auto.components.sidebar.MissionCreateDialog.41f764a7c2',
                            'Skip'
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          )}
          <DialogFooter>
            {memberResults === null ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  disabled={submitting}
                  onClick={resetAndClose}
                >
                  {translate('auto.components.sidebar.MissionCreateDialog.741e98ec23', 'Cancel')}
                </Button>
                <Button type="submit" size="sm" className="text-xs" disabled={!canSubmit}>
                  {submitting
                    ? translate(
                        'auto.components.sidebar.MissionCreateDialog.131ac9a3ca',
                        'Creating...'
                      )
                    : translate(
                        'auto.components.sidebar.MissionCreateDialog.470b9ba02f',
                        'Create Mission'
                      )}
                </Button>
              </>
            ) : (
              <Button type="button" size="sm" className="text-xs" onClick={finishIntoMissionsTab}>
                {translate('auto.components.sidebar.MissionCreateDialog.009decc6e5', 'Done')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
