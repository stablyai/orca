import type { TextGenerationFailureFields } from '../text-generation-failure-copy'

export type WorktreeIconGenerationRequest = { name: string }

export type WorktreeIconGenerationResult =
  | { success: true; svg: string }
  | ({ success: false; canceled?: boolean } & TextGenerationFailureFields)

const MAX_NAME_LENGTH = 120
const MAX_SVG_LENGTH = 6000

export function normalizeWorktreeIconName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH)
}

export function buildWorktreeIconPrompt(name: string): string {
  return `Design a tiny app-icon style SVG for a coding workspace named "${normalizeWorktreeIconName(name).replace(/"/g, "'")}".
Rules:
- Output ONLY the raw <svg> element, nothing else, no markdown fences.
- viewBox="0 0 18 15", no width/height attributes.
- It renders at 18x15 CSS px inside a rounded tile, so use a full-bleed background <rect width="18" height="15" rx="4"/> with a rich gradient, plus ONE bold simple white glyph (strokes >= 1.3) that represents the name.
- At most 6 shapes. No text, no <image>, no scripts, no external refs, no filters.
This is an icon-only task. Do not edit files, run commands, or use tools.`
}

const FORBIDDEN =
  /<(script|foreignObject|image|iframe|use|a)\b|\bon[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=\s*["'](?!#)/i

/** The first well-formed `<svg>…</svg>` in the agent's reply, or null when it is missing or unsafe. */
export function extractWorktreeIconSvg(raw: string): string | null {
  const start = raw.search(/<svg[\s>]/i)
  const end = raw.toLowerCase().lastIndexOf('</svg>')
  if (start < 0 || end < start) {
    return null
  }
  const svg = raw.slice(start, end + '</svg>'.length).trim()
  if (svg.length > MAX_SVG_LENGTH || FORBIDDEN.test(svg)) {
    return null
  }
  return /\bxmlns\s*=/.test(svg.slice(0, svg.indexOf('>')))
    ? svg
    : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
}
