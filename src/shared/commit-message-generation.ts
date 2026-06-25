import { cleanGeneratedCommitMessage, truncateDiffForPrompt } from './commit-message-prompt'
import type { TuiAgent } from './types'

export type CommitMessageDraftAgent = TuiAgent | 'custom'

export type CommitMessageDraftContext = {
  branch: string | null
  stagedSummary: string
  stagedPatch: string
}

export type CommitMessageDraftOptions = {
  agentId: CommitMessageDraftAgent
  model: string
  thinkingLevel?: string
  customPrompt?: string
  customAgentCommand?: string
}

export type GeneratedCommitMessage = {
  subject: string
  body: string
  message: string
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  const omitted = value.length - maxChars
  return `${value.slice(0, maxChars)}\n\n[truncated: ${omitted} characters omitted]`
}

export function buildCommitMessagePrompt(
  context: CommitMessageDraftContext,
  customPrompt: string
): string {
  // Why: the staged patch is dropped when it's too large to read, so fall back to
  // the file summary and tell the agent why the diff is missing.
  const patch = context.stagedPatch.trim()
    ? truncateDiffForPrompt(context.stagedPatch)
    : '(diff omitted — too large to read; infer the change from the staged file list above)'
  const base = [
    'You are generating a single git commit message.',
    'Return only the commit message text. Do not include a preamble, quotes, or code fences.',
    '',
    'Rules:',
    '- First line: imperative mood, <= 72 chars, no trailing period.',
    '- Optional body: blank line, then short wrapped bullet points or prose explaining WHY.',
    '- Capture the primary user-visible or developer-visible change.',
    '- Use only the staged changes below as context.',
    '- Do not include "Co-authored-by" or other git trailers.',
    '',
    `Branch: ${context.branch ?? '(detached)'}`,
    '',
    'Staged files:',
    limitSection(context.stagedSummary, 6_000),
    '',
    'Staged patch:',
    '```diff',
    patch,
    '```'
  ].join('\n')

  const trimmedPrompt = customPrompt.trim()
  if (!trimmedPrompt) {
    return base
  }
  return [base, '', 'Additional user prompt:', limitSection(trimmedPrompt, 4_000)].join('\n')
}

export function splitGeneratedCommitMessage(message: string): GeneratedCommitMessage {
  const normalized = cleanGeneratedCommitMessage(message)
  const firstNewline = normalized.indexOf('\n')
  const subjectLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline)
  const subject = subjectLine.trim().replace(/[.]+$/g, '').slice(0, 72).trimEnd()
  const body = firstNewline === -1 ? '' : normalized.slice(firstNewline + 1).trim()
  const safeSubject = subject.length > 0 ? subject : 'Update project files'
  return {
    subject: safeSubject,
    body,
    message: body.length > 0 ? `${safeSubject}\n\n${body}` : safeSubject
  }
}
