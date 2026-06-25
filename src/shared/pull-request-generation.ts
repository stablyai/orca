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
    '- If Current description contains a pull request or merge request template, preserve its headings, required sections, and checklists while filling relevant sections from the branch changes.',
    '- Leave genuinely unknown template items as TODO or unchecked instead of deleting them.',
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
  let text = raw.trim()
  const fencedBody = getJsonFenceBody(text)
  if (fencedBody !== null) {
    text = fencedBody.trim()
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1)
  }
  return text
}

function getJsonFenceBody(text: string): string | null {
  let bodyStart = getLineBreakEnd(text, 3)
  if (bodyStart === null && startsWithAsciiIgnoreCase(text, '```json', 0)) {
    bodyStart = getLineBreakEnd(text, 7)
  }
  if (bodyStart === null || !text.endsWith('```')) {
    return null
  }

  const closeStart = text.length - 3
  const bodyEnd = getBodyEndBeforeClosingFence(text, closeStart)
  return bodyEnd === null ? null : text.slice(bodyStart, bodyEnd)
}

function getLineBreakEnd(text: string, index: number): number | null {
  const code = text.charCodeAt(index)
  if (code === 10) {
    return index + 1
  }
  if (code === 13) {
    return text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1
  }
  return null
}

function getBodyEndBeforeClosingFence(text: string, closeStart: number): number | null {
  const previousCode = text.charCodeAt(closeStart - 1)
  if (previousCode === 10) {
    return text.charCodeAt(closeStart - 2) === 13 ? closeStart - 2 : closeStart - 1
  }
  if (previousCode === 13) {
    return closeStart - 1
  }
  return null
}

function startsWithAsciiIgnoreCase(value: string, search: string, startIndex: number): boolean {
  if (startIndex < 0 || startIndex + search.length > value.length) {
    return false
  }
  for (let index = 0; index < search.length; index++) {
    const code = value.charCodeAt(startIndex + index)
    const normalizedCode = code >= 65 && code <= 90 ? code + 32 : code
    if (normalizedCode !== search.charCodeAt(index)) {
      return false
    }
  }
  return true
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
