import type { CommitMessageDraftContext } from '../commit-message-generation'
import { truncateDiffForPrompt } from '../commit-message-prompt'

/** Prompt for a Perforce changelist description: a title line followed by one bullet per relevant change. */
export function buildPerforceDescriptionPrompt(
  context: CommitMessageDraftContext,
  instructions: string
): string {
  const patch = context.stagedPatch.trim()
    ? truncateDiffForPrompt(context.stagedPatch)
    : '(diff omitted — infer the change from the file list above)'
  const base = [
    'You are writing the description of a Perforce changelist.',
    'Return only the description text. Do not include a preamble, quotes, or code fences.',
    '',
    'Use exactly this format:',
    '<changelist title>',
    '- <description entry 1>',
    '- <description entry 2>',
    '- ... one entry for each relevant change',
    '',
    'Rules:',
    '- The first line is the title: imperative mood, <= 72 chars, no trailing period.',
    '- Follow it immediately with the bullet lines; do not add a blank line between them.',
    '- Every other line starts with "- " and describes one change and, where clear, why it was made.',
    '- Keep each entry short; do not list a file when an entry already covers it.',
    '- Use only the changes below as context.',
    '',
    context.stagedSummary,
    '',
    'Diff:',
    '```diff',
    patch,
    '```'
  ].join('\n')
  const extra = instructions.trim()
  return extra ? `${base}\n\nAdditional instructions:\n${extra.slice(0, 4_000)}` : base
}
