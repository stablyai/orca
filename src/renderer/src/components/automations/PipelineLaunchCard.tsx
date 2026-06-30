import React from 'react'
import { Play, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { PipelineTemplateSummary } from '../../../../shared/pipeline-template-types'
import type {
  PipelinePrdCandidate,
  PipelineRecoveryReport
} from '../../../../shared/pipelines-types'
import type { Repo } from '../../../../shared/types'
import { Field } from './automation-page-parts'
import { getPipelinePrdTabKey, isSequentialReviewerTemplate } from './pipeline-panel-state'

type PipelineLaunchCardProps = {
  templates: PipelineTemplateSummary[]
  repos: Repo[]
  candidates: PipelinePrdCandidate[]
  selectedTemplateId: string
  selectedRepoId: string
  selectedPrdKey: string
  selectedCandidate: PipelinePrdCandidate | null
  providerRepo: { owner: string; repo: string } | null
  executionTargetLabel: string
  latestPendingRecoveryReport: PipelineRecoveryReport | null
  sourceBranch: string
  targetBranch: string
  maxConcurrent: string
  maxIterations: string
  isLoading: boolean
  actionKey: string | null
  launchBlockReason: string | null
  canRun: boolean
  onTemplateChange: (value: string) => void
  onRepoChange: (value: string) => void
  onPrdChange: (value: string) => void
  onSourceBranchChange: (value: string) => void
  onTargetBranchChange: (value: string) => void
  onMaxConcurrentChange: (value: string) => void
  onMaxIterationsChange: (value: string) => void
  onRefresh: () => void
  onRun: () => void
  onAcknowledgeRecovery: () => void
}

export function PipelineLaunchCard(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/20 shadow-sm">
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
        <div>
          <div className="text-sm font-medium">Pipeline run</div>
          <div className="text-xs text-muted-foreground">
            PRD work set, Codex agents, real Pipeline RPC
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={props.isLoading || props.actionKey !== null}
          onClick={props.onRefresh}
        >
          <RefreshCw className={cn('size-3.5', props.isLoading && 'animate-spin')} />
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 p-3">
        <TemplateField {...props} />
        <RepoField {...props} />
        <PrdField {...props} />
        <PrdSummary {...props} />
        <RecoveryAlert {...props} />
        <BranchFields {...props} />
        <IterationFields {...props} />
        <Button type="button" disabled={!props.canRun} onClick={props.onRun}>
          {props.actionKey === 'run' ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Run Pipeline
        </Button>
        {props.launchBlockReason ? (
          <div className="text-xs text-muted-foreground">{props.launchBlockReason}</div>
        ) : null}
      </div>
    </div>
  )
}

function TemplateField(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <Field label="Template">
      <Select value={props.selectedTemplateId} onValueChange={props.onTemplateChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose template" />
        </SelectTrigger>
        <SelectContent>
          {props.templates.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function RepoField(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <Field label="Repo">
      <Select value={props.selectedRepoId} onValueChange={props.onRepoChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose repo" />
        </SelectTrigger>
        <SelectContent>
          {props.repos.map((repo) => (
            <SelectItem key={repo.id} value={repo.id}>
              {repo.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function PrdField(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <Field label="PRD work set">
      <Select value={props.selectedPrdKey} onValueChange={props.onPrdChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose PRD" />
        </SelectTrigger>
        <SelectContent>
          {props.candidates.map((candidate) => (
            <SelectItem
              key={getPipelinePrdTabKey(candidate)}
              value={getPipelinePrdTabKey(candidate)}
            >
              #{candidate.prdIssueNumber} · {candidate.prdTitle}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function PrdSummary(props: PipelineLaunchCardProps): React.JSX.Element {
  if (!props.selectedCandidate) {
    return (
      <div className="rounded-md border border-border/50 bg-background px-3 py-2 text-sm text-muted-foreground">
        No open Pipeline PRD candidates found for this repo.
      </div>
    )
  }
  return (
    <div className="grid gap-2 rounded-md border border-border/50 bg-background px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{props.selectedCandidate.pipelinePrdLabel}</span>
        <Badge variant={props.selectedCandidate.activeRunId ? 'dot' : 'outline'}>
          {props.selectedCandidate.readyTaskCount} ready / {props.selectedCandidate.openTaskCount}{' '}
          open
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground">
        {props.providerRepo
          ? `${props.providerRepo.owner}/${props.providerRepo.repo}`
          : 'No GitHub provider repo detected'}{' '}
        · {props.executionTargetLabel}
        {props.selectedCandidate.activeRunId
          ? ` · active ${props.selectedCandidate.activeRunId}`
          : ''}
      </div>
    </div>
  )
}

function RecoveryAlert(props: PipelineLaunchCardProps): React.JSX.Element | null {
  const report = props.latestPendingRecoveryReport
  if (!report) {
    return null
  }
  return (
    <div className="grid gap-2 rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm">
      <div className="font-medium">Interrupted run needs acknowledgement</div>
      <div className="text-xs text-muted-foreground">
        {report.summary.openReadyTaskIssueNumbers.length} open ready tasks ·{' '}
        {report.summary.dirtyWorktreeIds.length} dirty worktrees · interrupted{' '}
        {report.interruptedRunId}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.actionKey !== null}
        onClick={props.onAcknowledgeRecovery}
      >
        {props.actionKey === 'ack-recovery' ? (
          <RefreshCw className="size-3.5 animate-spin" />
        ) : null}
        Acknowledge
      </Button>
    </div>
  )
}

function BranchFields(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label="Source branch">
        <Input
          value={props.sourceBranch}
          onChange={(event) => props.onSourceBranchChange(event.target.value)}
        />
      </Field>
      <Field label="Target branch">
        <Input
          value={props.targetBranch}
          onChange={(event) => props.onTargetBranchChange(event.target.value)}
        />
      </Field>
    </div>
  )
}

function IterationFields(props: PipelineLaunchCardProps): React.JSX.Element {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {isSequentialReviewerTemplate(props.selectedTemplateId) ? (
        <div className="rounded-md border border-border/50 bg-background px-3 py-2 text-sm text-muted-foreground">
          Sequential reviewer runs one task at a time.
        </div>
      ) : (
        <Field label="Max concurrent">
          <Input
            type="number"
            min={1}
            value={props.maxConcurrent}
            onChange={(event) => props.onMaxConcurrentChange(event.target.value)}
          />
        </Field>
      )}
      <Field label="Max iterations">
        <Input
          type="number"
          min={1}
          value={props.maxIterations}
          onChange={(event) => props.onMaxIterationsChange(event.target.value)}
        />
      </Field>
    </div>
  )
}
