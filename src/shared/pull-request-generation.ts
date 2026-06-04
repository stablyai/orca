import { truncateDiffForPrompt } from './commit-message-prompt'

export type PullRequestDraftContext = {
  branch: string | null
  base: string
  branchChangedByPreparation: boolean
  currentTitle: string
  currentBody: string
  currentDraft: boolean
  commitSummary: string
  changeSummary: string
  patch: string
}

export type GeneratedPullRequestFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  const omitted = value.length - maxChars
  return `${value.slice(0, maxChars)}\n\n[truncated: ${omitted} characters omitted]`
}

export function buildPullRequestFieldsPrompt(
  context: PullRequestDraftContext,
  customPrompt: string
): string {
  const base = [
    'You are generating pull request details.',
    'Return ONLY compact JSON with this exact shape:',
    '{"base":"branch-name","title":"short title","body":"markdown description","draft":false}',
    '',
    'Rules:',
    '- Use the branch diff and commits below as source of truth.',
    '- Keep the base branch as the current base unless the diff clearly targets a different branch.',
    '- Title: concise, specific, no trailing period.',
    '- Body: useful Markdown summary for reviewers. Include testing notes only when evidence exists.',
    '- draft: true only when the changes clearly look unfinished, WIP, or unsafe to review.',
    '- Do not include labels, reviewers, code fences, prose, or any keys beyond base/title/body/draft.',
    '',
    `Head branch: ${context.branch ?? '(detached)'}`,
    `Current base: ${context.base}`,
    `Current title: ${context.currentTitle || '(empty)'}`,
    `Current description: ${context.currentBody || '(empty)'}`,
    `Current draft: ${context.currentDraft ? 'true' : 'false'}`,
    '',
    'Commits:',
    limitSection(context.commitSummary || '(none)', 8_000),
    '',
    'Changed files:',
    limitSection(context.changeSummary || '(none)', 8_000),
    '',
    'Patch:',
    '```diff',
    truncateDiffForPrompt(context.patch),
    '```'
  ].join('\n')

  const trimmedPrompt = customPrompt.trim()
  if (!trimmedPrompt) {
    return [
      base,
      '',
      'Final output requirement:',
      'Return compact JSON only with keys base, title, body, and draft. No prose or code fences.'
    ].join('\n')
  }
  return [
    base,
    '',
    'Additional user prompt:',
    limitSection(trimmedPrompt, 4_000),
    '',
    'Final output requirement:',
    'Return compact JSON only with keys base, title, body, and draft. No prose or code fences.'
  ].join('\n')
}

function stripJsonFence(raw: string): string {
  let text = raw.replace(/\r\n/g, '\n').trim()
  const fenced = text.match(/^```(?:json)?\n([\s\S]*?)\n```$/i)
  if (fenced) {
    text = fenced[1].trim()
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1)
  }
  return text
}

export function parseGeneratedPullRequestFields(
  raw: string,
  fallback: Pick<PullRequestDraftContext, 'base' | 'currentTitle' | 'currentBody' | 'currentDraft'>
): GeneratedPullRequestFields {
  const parsed = JSON.parse(stripJsonFence(raw)) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.')
  }
  const record = parsed as Record<string, unknown>
  const base = typeof record.base === 'string' ? record.base.trim() : fallback.base
  const title =
    typeof record.title === 'string' && record.title.trim()
      ? record.title.trim().replace(/[.]+$/g, '')
      : fallback.currentTitle.trim()
  const body =
    typeof record.body === 'string' ? record.body.replace(/\s+$/g, '') : fallback.currentBody
  const draft = typeof record.draft === 'boolean' ? record.draft : fallback.currentDraft

  return {
    base: base || fallback.base,
    title: title || 'Update project files',
    body,
    draft
  }
}
