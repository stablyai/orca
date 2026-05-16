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
  customInstructions: string
): string {
  const patch = truncateDiffForPrompt(context.stagedPatch)
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

  const trimmedInstructions = customInstructions.trim()
  if (!trimmedInstructions) {
    return base
  }
  return [
    base,
    '',
    'Additional instructions from user:',
    limitSection(trimmedInstructions, 4_000)
  ].join('\n')
}

export function splitGeneratedCommitMessage(message: string): GeneratedCommitMessage {
  const normalized = cleanGeneratedCommitMessage(message)
  const [subjectLine = '', ...bodyLines] = normalized.split('\n')
  const subject = subjectLine.trim().replace(/[.]+$/g, '').slice(0, 72).trimEnd()
  const body = bodyLines.join('\n').trim()
  const safeSubject = subject.length > 0 ? subject : 'Update project files'
  return {
    subject: safeSubject,
    body,
    message: body.length > 0 ? `${safeSubject}\n\n${body}` : safeSubject
  }
}
