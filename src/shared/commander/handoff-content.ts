import type { CommanderMemoryRevision } from './memory-contract'

export const HANDOFF_GOAL_LIMIT = 240
export const HANDOFF_SECTION_LIMIT = 4000
export type HandoffFields = { goal: string; progress: string; nextStep: string }

type PageHeader = Pick<CommanderMemoryRevision, 'pageId' | 'kind' | 'deleted'>
type HandoffPage = PageHeader & Pick<CommanderMemoryRevision, 'title' | 'body'>

const handoffId = /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const progressHeading = '## Progress\n\n'
const nextHeading = '\n\n## Next step\n\n'

export function isHandoffPage(page: PageHeader): boolean {
  return !page.deleted && page.kind === 'note' && handoffId.test(page.pageId)
}

// Quote literal separator lines so pasted Markdown, including existing escapes, round-trips.
function encodeSection(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/^(\\*## Next step)$/gm, '\\$1')
}

function decodeSection(value: string): string {
  return value.replace(/^\\(\\*## Next step)$/gm, '$1')
}

export function encodeHandoffBody({
  progress,
  nextStep
}: Pick<HandoffFields, 'progress' | 'nextStep'>): string {
  return progressHeading + encodeSection(progress) + nextHeading + encodeSection(nextStep)
}

export function readHandoff(page: HandoffPage): HandoffFields | null {
  if (!isHandoffPage(page) || !page.body.startsWith(progressHeading)) {
    return null
  }
  const at = page.body.indexOf(nextHeading, progressHeading.length)
  if (at === -1 || page.body.includes(nextHeading, at + nextHeading.length)) {
    return null
  }
  const goal = page.title
  const progress = decodeSection(page.body.slice(progressHeading.length, at))
  const nextStep = decodeSection(page.body.slice(at + nextHeading.length))
  if (
    !goal.trim() ||
    goal.length > HANDOFF_GOAL_LIMIT ||
    progress.length > HANDOFF_SECTION_LIMIT ||
    nextStep.length > HANDOFF_SECTION_LIMIT
  ) {
    return null
  }
  return { goal, progress, nextStep }
}

export function handoffPrompt(page: CommanderMemoryRevision): string {
  const handoff = readHandoff(page)
  if (!handoff) {
    throw new Error('Invalid Commander handoff.')
  }
  const lines = [
    'Continue this saved goal. Check the current state on this host before acting.',
    `Goal: ${handoff.goal}`,
    ...(page.projectId ? [`Project: ${page.projectId}`] : []),
    ...(handoff.progress.trim() ? [`Progress:\n${handoff.progress}`] : []),
    ...(handoff.nextStep.trim() ? [`Next step:\n${handoff.nextStep}`] : []),
    `Orca Memory: ${page.pageId} v${page.version}`
  ]
  return lines.join('\n\n')
}
