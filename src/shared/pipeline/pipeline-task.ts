import { triageIssue } from '../github/issue-flow/issue-triage'
import type { IssueInfo } from '../github/pull-requests/pull-request-types'

export type PipelineTaskSource =
  | {
      kind: 'prompt'
      prompt: string
    }
  | {
      kind: 'github_issue'
      repo: string
      number: number
      url: string
      labels?: readonly string[]
    }
  | {
      kind: 'linear_ticket'
      identifier: string
      url?: string
      state?: string
    }

export type PipelineTask = {
  id: string
  title: string
  description?: string
  source: PipelineTaskSource
  createdAt: number
}

export type CreatePromptTaskOptions = {
  id?: string
  title?: string
  createdAt?: number
}

export type CreateExternalTaskOptions = {
  id?: string
  createdAt?: number
}

export type LinearTicketInput = {
  identifier: string
  title: string
  description?: string
  url?: string
  state?: string
}

const PROMPT_TITLE_MAX_CHARS = 80

function derivePromptTitle(prompt: string): string {
  const firstLine =
    prompt
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? 'Untitled task'
  if (firstLine.length <= PROMPT_TITLE_MAX_CHARS) {
    return firstLine
  }
  return `${firstLine.slice(0, PROMPT_TITLE_MAX_CHARS - 1)}…`
}

export function createPromptPipelineTask(
  prompt: string,
  options?: CreatePromptTaskOptions
): PipelineTask {
  const normalized = prompt.trim()
  const createdAt = options?.createdAt ?? Date.now()
  return {
    id: options?.id ?? `prompt:${createdAt}`,
    title: options?.title?.trim() || derivePromptTitle(normalized),
    description: normalized,
    source: { kind: 'prompt', prompt: normalized },
    createdAt
  }
}

export function createGithubIssuePipelineTask(
  repo: string,
  issue: IssueInfo,
  options?: CreateExternalTaskOptions
): PipelineTask {
  return {
    id: options?.id ?? `github:${repo}#${issue.number}`,
    title: issue.title,
    description: issue.description,
    source: {
      kind: 'github_issue',
      repo,
      number: issue.number,
      url: issue.url,
      labels: issue.labels
    },
    createdAt: options?.createdAt ?? Date.now()
  }
}

export function createLinearTicketPipelineTask(
  ticket: LinearTicketInput,
  options?: CreateExternalTaskOptions
): PipelineTask {
  return {
    id: options?.id ?? `linear:${ticket.identifier}`,
    title: ticket.title,
    description: ticket.description,
    source: {
      kind: 'linear_ticket',
      identifier: ticket.identifier,
      url: ticket.url,
      state: ticket.state
    },
    createdAt: options?.createdAt ?? Date.now()
  }
}

export function derivePipelineTaskTriageEvent(
  task: PipelineTask,
  options?: { requireApproval?: boolean }
): 'triaged:auto' | 'triaged:manual' {
  if (options?.requireApproval !== undefined) {
    return options.requireApproval ? 'triaged:manual' : 'triaged:auto'
  }
  if (task.source.kind === 'prompt') {
    return 'triaged:auto'
  }
  const result = triageIssue({
    title: task.title,
    body: task.description,
    labels: task.source.kind === 'github_issue' ? task.source.labels : undefined
  })
  return result.needsApproval ? 'triaged:manual' : 'triaged:auto'
}

export function buildPipelineReworkPrompt(args: {
  task: PipelineTask
  stage: 'review' | 'ci'
  report: string
}): string {
  const heading = args.stage === 'review' ? 'Review requested changes' : 'CI checks failed'
  return [
    `${heading} for task "${args.task.title}".`,
    'Fix in the existing worktree and branch — do not open a new branch.',
    'Run `pnpm check:changed` before pushing.',
    '',
    'Details:',
    args.report.trim()
  ].join('\n')
}
