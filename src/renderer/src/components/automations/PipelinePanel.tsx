import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type { PipelineTemplateSummary } from '../../../../shared/pipeline-template-types'
import type {
  PipelinePrdCandidate,
  PipelineRecoveryReport,
  PipelineRun,
  PipelineRunDetail
} from '../../../../shared/pipelines-types'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import {
  DEFAULT_PIPELINE_TEMPLATE_ID,
  buildPipelineRunInputFromCandidate,
  canCancelPipelineRun,
  getLatestPendingRecoveryReport,
  getPipelineLaunchBlockReason,
  getPipelinePrdTabKey,
  getPipelineRunStatusLabel,
  getPipelineRunStatusVariant
} from './pipeline-panel-state'
import { PipelineLaunchCard } from './PipelineLaunchCard'
import { PipelineRunDetailPane } from './PipelineRunDetailPane'

type PipelinePanelProps = {
  repos: Repo[]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}

const DEFAULT_PIPELINE_AGENT: TuiAgent = 'codex'

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getRepoConnectionId(repo: Repo | null): string | null {
  const connectionId = repo && 'connectionId' in repo ? repo.connectionId : null
  return typeof connectionId === 'string' && connectionId.trim() ? connectionId : null
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Pipeline request failed.'
}

function getProviderRepo(repo: Repo | null): { owner: string; repo: string } | null {
  if (repo?.upstream) {
    return { owner: repo.upstream.owner, repo: repo.upstream.repo }
  }
  const [owner, repoName] = (repo?.displayName ?? '').split('/')
  if (owner && repoName) {
    return { owner, repo: repoName }
  }
  return null
}

export function PipelinePanel({ repos, settings }: PipelinePanelProps): React.JSX.Element {
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const [templates, setTemplates] = useState<PipelineTemplateSummary[]>([])
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [detail, setDetail] = useState<PipelineRunDetail | null>(null)
  const [candidates, setCandidates] = useState<PipelinePrdCandidate[]>([])
  const [recoveryReports, setRecoveryReports] = useState<PipelineRecoveryReport[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_PIPELINE_TEMPLATE_ID)
  const [selectedRepoId, setSelectedRepoId] = useState('')
  const [selectedPrdKey, setSelectedPrdKey] = useState('')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [sourceBranch, setSourceBranch] = useState('main')
  const [targetBranch, setTargetBranch] = useState('pipeline-output')
  const [maxConcurrent, setMaxConcurrent] = useState('2')
  const [maxIterations, setMaxIterations] = useState('2')
  const [isLoading, setIsLoading] = useState(true)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null
  const selectedRepo = repos.find((repo) => repo.id === selectedRepoId) ?? null
  const selectedProviderRepo = useMemo(() => getProviderRepo(selectedRepo), [selectedRepo])
  const selectedCandidate =
    candidates.find((candidate) => getPipelinePrdTabKey(candidate) === selectedPrdKey) ??
    candidates[0] ??
    null
  const latestPendingRecoveryReport = selectedCandidate
    ? getLatestPendingRecoveryReport(selectedCandidate, recoveryReports)
    : null
  const launchBlockReason = getPipelineLaunchBlockReason({
    candidate: selectedCandidate,
    latestPendingRecoveryReport
  })
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? null

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    setError(null)
    try {
      const [templateResult, runResult] = await Promise.all([
        callRuntimeRpc<{ templates: PipelineTemplateSummary[] }>(
          runtimeTarget,
          'pipelines.templateList',
          {}
        ),
        callRuntimeRpc<{ runs: PipelineRun[] }>(runtimeTarget, 'pipelines.list', { limit: 50 })
      ])
      setTemplates(templateResult.templates)
      setRuns(runResult.runs)
      setSelectedTemplateId((current) =>
        templateResult.templates.some((template) => template.id === current)
          ? current
          : DEFAULT_PIPELINE_TEMPLATE_ID
      )
      setSelectedRunId((current) => current ?? runResult.runs[0]?.id ?? null)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsLoading(false)
    }
  }, [runtimeTarget])

  const refreshCandidates = useCallback(async (): Promise<void> => {
    if (!selectedRepo || !selectedProviderRepo) {
      setCandidates([])
      setRecoveryReports([])
      setSelectedPrdKey('')
      return
    }
    setError(null)
    try {
      const [candidateResult, recoveryResult] = await Promise.all([
        callRuntimeRpc<{ candidates: PipelinePrdCandidate[] }>(
          runtimeTarget,
          'pipelines.prdCandidates',
          {
            repoId: selectedRepo.id,
            owner: selectedProviderRepo.owner,
            repo: selectedProviderRepo.repo,
            limit: 20
          }
        ),
        callRuntimeRpc<{ reports: PipelineRecoveryReport[] }>(
          runtimeTarget,
          'pipelines.recoveryReportList',
          { repoId: selectedRepo.id }
        )
      ])
      setCandidates(candidateResult.candidates)
      setRecoveryReports(recoveryResult.reports)
      setSelectedPrdKey((current) => {
        if (
          candidateResult.candidates.some(
            (candidate) => getPipelinePrdTabKey(candidate) === current
          )
        ) {
          return current
        }
        return candidateResult.candidates[0]
          ? getPipelinePrdTabKey(candidateResult.candidates[0])
          : ''
      })
    } catch (err) {
      setCandidates([])
      setRecoveryReports([])
      setError(getErrorMessage(err))
    }
  }, [runtimeTarget, selectedProviderRepo, selectedRepo])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!selectedRepoId && repos[0]) {
      setSelectedRepoId(repos[0].id)
    }
  }, [repos, selectedRepoId])

  useEffect(() => {
    void refreshCandidates()
  }, [refreshCandidates])

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null)
      return
    }
    let cancelled = false
    setError(null)
    void callRuntimeRpc<PipelineRunDetail>(runtimeTarget, 'pipelines.show', {
      runId: selectedRunId
    })
      .then((nextDetail) => {
        if (!cancelled) {
          setDetail(nextDetail)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setDetail(null)
          setError(getErrorMessage(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [runtimeTarget, selectedRunId])

  const runPipeline = useCallback(async (): Promise<void> => {
    if (!selectedTemplate || !selectedRepo || !selectedCandidate) {
      setError('Choose a template, repo, and PRD before starting a Pipeline run.')
      return
    }
    if (launchBlockReason) {
      setError(launchBlockReason)
      return
    }
    const connectionId = getRepoConnectionId(selectedRepo)
    const input = buildPipelineRunInputFromCandidate({
      candidate: selectedCandidate,
      templateId: selectedTemplate.id,
      repoId: selectedRepo.id,
      sourceBranch: sourceBranch.trim() || 'main',
      targetBranch: targetBranch.trim() || 'pipeline-output',
      maxConcurrent: parsePositiveInteger(maxConcurrent, selectedTemplate.maxConcurrentDefault),
      maxIterations: parsePositiveInteger(maxIterations, selectedTemplate.maxIterationsDefault),
      agentId: DEFAULT_PIPELINE_AGENT,
      executionTargetType: connectionId ? 'ssh' : 'local',
      executionTargetId: connectionId ?? undefined
    })
    setActionKey('run')
    setError(null)
    try {
      const result = await callRuntimeRpc<{ run: PipelineRun }>(
        runtimeTarget,
        'pipelines.run',
        input
      )
      setSelectedRunId(result.run.id)
      await refresh()
      await refreshCandidates()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActionKey(null)
    }
  }, [
    launchBlockReason,
    maxConcurrent,
    maxIterations,
    refresh,
    refreshCandidates,
    runtimeTarget,
    selectedCandidate,
    selectedRepo,
    selectedTemplate,
    sourceBranch,
    targetBranch
  ])

  const cancelSelectedRun = useCallback(async (): Promise<void> => {
    if (!selectedRun || !canCancelPipelineRun(selectedRun.status)) {
      return
    }
    setActionKey('cancel')
    setError(null)
    try {
      const result = await callRuntimeRpc<{ run: PipelineRun }>(runtimeTarget, 'pipelines.cancel', {
        runId: selectedRun.id,
        preserveWorktrees: true
      })
      setRuns((current) => current.map((run) => (run.id === result.run.id ? result.run : run)))
      setSelectedRunId(result.run.id)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActionKey(null)
    }
  }, [runtimeTarget, selectedRun])

  const acknowledgeRecoveryReport = useCallback(async (): Promise<void> => {
    if (!latestPendingRecoveryReport) {
      return
    }
    setActionKey('ack-recovery')
    setError(null)
    try {
      await callRuntimeRpc(runtimeTarget, 'pipelines.recoveryReportAcknowledge', {
        reportId: latestPendingRecoveryReport.id
      })
      await refreshCandidates()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setActionKey(null)
    }
  }, [latestPendingRecoveryReport, refreshCandidates, runtimeTarget])

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(20rem,.9fr)_minmax(28rem,1.1fr)]">
        <div className="flex min-h-0 flex-col gap-4">
          <PipelineLaunchCard
            templates={templates}
            repos={repos}
            candidates={candidates}
            selectedTemplateId={selectedTemplateId}
            selectedRepoId={selectedRepoId}
            selectedPrdKey={selectedPrdKey}
            selectedCandidate={selectedCandidate}
            providerRepo={selectedProviderRepo}
            executionTargetLabel={getRepoConnectionId(selectedRepo) ? 'SSH target' : 'Local target'}
            latestPendingRecoveryReport={latestPendingRecoveryReport}
            sourceBranch={sourceBranch}
            targetBranch={targetBranch}
            maxConcurrent={maxConcurrent}
            maxIterations={maxIterations}
            isLoading={isLoading}
            actionKey={actionKey}
            launchBlockReason={launchBlockReason}
            canRun={
              Boolean(selectedTemplate && selectedRepo && selectedCandidate) &&
              launchBlockReason === null &&
              actionKey === null
            }
            onTemplateChange={setSelectedTemplateId}
            onRepoChange={setSelectedRepoId}
            onPrdChange={setSelectedPrdKey}
            onSourceBranchChange={setSourceBranch}
            onTargetBranchChange={setTargetBranch}
            onMaxConcurrentChange={setMaxConcurrent}
            onMaxIterationsChange={setMaxIterations}
            onRefresh={() => void refresh()}
            onRun={() => void runPipeline()}
            onAcknowledgeRecovery={() => void acknowledgeRecoveryReport()}
          />

          <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="text-sm font-medium">Run history</div>
              <div className="text-xs text-muted-foreground">{runs.length} runs</div>
            </div>
            <div className="divide-y divide-border/50">
              {runs.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  data-current={selectedRunId === run.id}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selectedRunId === run.id && 'bg-accent text-accent-foreground'
                  )}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{run.templateId}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">
                      {run.sourceBranch} to {run.targetBranch} · {formatDateTime(run.createdAt)}
                    </div>
                  </div>
                  <Badge variant={getPipelineRunStatusVariant(run.status)}>
                    {getPipelineRunStatusLabel(run.status)}
                  </Badge>
                </button>
              ))}
              {runs.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No Pipeline runs yet.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <PipelineRunDetailPane
          detail={detail}
          selectedRun={selectedRun}
          isLoading={isLoading}
          actionKey={actionKey}
          onCancel={() => void cancelSelectedRun()}
        />
      </div>
    </div>
  )
}
