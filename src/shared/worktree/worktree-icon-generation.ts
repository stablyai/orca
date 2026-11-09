import type { TextGenerationFailureFields } from '../text-generation-failure-copy'

export type WorktreeIconGenerationRequest = { name: string; requestId: string }
export type WorktreeIconGenerationCancellation = { requestId: string }

export type WorktreeIconGenerationResult =
  | { success: true; svg: string }
  | ({ success: false; canceled?: boolean } & TextGenerationFailureFields)

const MAX_NAME_LENGTH = 120
const MAX_SVG_LENGTH = 6000
// 24 icons took ~49s on Haiku against the 60s generation timeout; 16 took ~28s at the same per-icon cost.
export const MAX_WORKTREE_ICON_BATCH = 16

export function normalizeWorktreeIconName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH)
}

/** The `{workspaces}` template value: one numbered, quoted name per line. */
export function formatWorktreeIconBatchList(names: readonly string[]): string {
  return names
    .map((name, index) => `${index + 1}. "${normalizeWorktreeIconName(name).replace(/"/g, "'")}"`)
    .join('\n')
}

export function buildWorktreeIconBatchPrompt(names: readonly string[]): string {
  return `Design tiny app-icon style SVGs for the coding workspaces listed below, one per workspace.
Workspaces:
${formatWorktreeIconBatchList(names)}
Rules:
- Output ONLY the raw <svg> elements in list order, nothing else, no markdown fences.
- Start each with <svg id="icon-N" where N is the workspace number.
- viewBox="0 0 18 15", no width/height attributes.
- Each renders at 18x15 CSS px inside a rounded tile, so use a full-bleed background <rect width="18" height="15" rx="4"/> with a rich gradient, plus ONE bold simple white glyph (strokes >= 1.3) that represents the name.
- Give every gradient an id that is unique across all icons.
- At most 6 shapes per icon. No text, no <image>, no scripts, no external refs, no filters.
This is an icon-only task. Do not edit files, run commands, or use tools.`
}

const FORBIDDEN =
  /<(script|foreignObject|image|iframe|use|a)\b|\bon[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i

function sanitizeSvg(svg: string): string | null {
  if (svg.length > MAX_SVG_LENGTH || FORBIDDEN.test(svg)) {
    return null
  }
  return /\bxmlns\s*=/.test(svg.slice(0, svg.indexOf('>')))
    ? svg
    : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
}

/** One safe SVG per requested name, matched by `id="icon-N"`, else by order when every icon came back. */
export function extractWorktreeIconSvgs(raw: string, count: number): (string | null)[] {
  const blocks = raw.match(/<svg[\s>][\s\S]*?<\/svg>/gi) ?? []
  const icons: (string | null)[] = Array.from({ length: count }, () => null)
  const unnumbered: string[] = []
  for (const block of blocks) {
    const id = /^<svg\b[^>]*\bid\s*=\s*["']icon-(\d+)["']/i.exec(block)?.[1]
    const index = id === undefined ? -1 : Number(id) - 1
    if (index >= 0 && index < count && icons[index] === null) {
      icons[index] = sanitizeSvg(block.trim())
    } else {
      unnumbered.push(block.trim())
    }
  }
  if (icons.every((icon) => icon === null) && unnumbered.length === count) {
    return unnumbered.map(sanitizeSvg)
  }
  return icons
}
