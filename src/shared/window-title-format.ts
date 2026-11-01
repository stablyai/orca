export type WindowTitleSeparatorId = 'em-dash' | 'hyphen' | 'pipe'

export const WINDOW_TITLE_SEPARATORS: Record<WindowTitleSeparatorId, string> = {
  'em-dash': ' — ',
  hyphen: ' - ',
  pipe: ' | '
}

export type WindowTitleGlobalSettings = {
  /** Opt-in: puts project, branch and focused tab in the window title for external time trackers. Absent reads as off. */
  windowTitleShowWorkspace?: boolean
  /** Token template; absent or blank reads as the default. */
  windowTitleTemplate?: string
  windowTitleSeparator?: WindowTitleSeparatorId
}

export const DEFAULT_WINDOW_TITLE_TEMPLATE =
  '${project}${separator}${branch}${separator}${tab}${separator}${app}'
export const DEFAULT_WINDOW_TITLE_SEPARATOR: WindowTitleSeparatorId = 'em-dash'

export const WINDOW_TITLE_TEMPLATE_MAX_LENGTH = 200
export const WINDOW_TITLE_SEGMENT_MAX_GRAPHEMES = 60
export const WINDOW_TITLE_MAX_GRAPHEMES = 200

export type WindowTitleTokens = {
  app: string
  /** Non-empty outside the workspace view; replaces the template with `<view> — <app>`. */
  view?: string
  project?: string
  workspace?: string
  branch?: string
  tab?: string
  agent?: string
}

// Strips C0/C1 controls (OSC titles can carry them) and bidi overrides/isolates.
// oxlint-disable-next-line no-control-regex -- the control bytes are exactly what this removes
const UNSAFE_TITLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g
const TOKEN_PATTERN = /\$\{(\w+)\}/g
const ELLIPSIS = '…'

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function sanitizeWindowTitleText(text: string): string {
  return text.replace(UNSAFE_TITLE_CHARACTERS, ' ').replace(/\s+/g, ' ').trim()
}

function clampGraphemes(text: string, max: number): string {
  // Fast path: a string of at most `max` code units cannot exceed `max` graphemes.
  if (text.length <= max) {
    return text
  }
  const graphemes = Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
  if (graphemes.length <= max) {
    return text
  }
  return (
    graphemes
      .slice(0, max - 1)
      .join('')
      .trimEnd() + ELLIPSIS
  )
}

/** Final guard for any string headed to the OS window title. */
export function finalizeWindowTitle(text: string): string {
  return clampGraphemes(sanitizeWindowTitleText(text), WINDOW_TITLE_MAX_GRAPHEMES)
}

export function normalizeWindowTitleTemplate(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_WINDOW_TITLE_TEMPLATE
  }
  const trimmed = value.trim().slice(0, WINDOW_TITLE_TEMPLATE_MAX_LENGTH)
  return trimmed || DEFAULT_WINDOW_TITLE_TEMPLATE
}

export function normalizeWindowTitleSeparator(value: unknown): WindowTitleSeparatorId {
  return typeof value === 'string' && Object.hasOwn(WINDOW_TITLE_SEPARATORS, value)
    ? // SAFETY: Object.hasOwn on the separator table proves `value` is a WindowTitleSeparatorId.
      (value as WindowTitleSeparatorId)
    : DEFAULT_WINDOW_TITLE_SEPARATOR
}

function templateUsesToken(template: string, name: string): boolean {
  return Array.from(template.matchAll(TOKEN_PATTERN)).some((match) => match[1] === name)
}

function clampSegment(text: string | undefined): string {
  return clampGraphemes(sanitizeWindowTitleText(text ?? ''), WINDOW_TITLE_SEGMENT_MAX_GRAPHEMES)
}

export function formatWindowTitle(args: {
  template: string
  separator: WindowTitleSeparatorId
  tokens: WindowTitleTokens
}): string {
  const separator = WINDOW_TITLE_SEPARATORS[args.separator]
  const { tokens } = args
  const app = clampSegment(tokens.app)
  const view = clampSegment(tokens.view)
  if (view) {
    return finalizeWindowTitle([view, app].filter(Boolean).join(separator))
  }

  const workspace = clampSegment(tokens.workspace)
  const branch = clampSegment(tokens.branch)
  const template = normalizeWindowTitleTemplate(args.template)
  const values: Record<string, string> = {
    app,
    project: clampSegment(tokens.project),
    workspace,
    // Folder and floating workspaces have no branch; name the workspace in that slot instead.
    branch: branch || (templateUsesToken(template, 'workspace') ? '' : workspace),
    tab: clampSegment(tokens.tab),
    agent: clampSegment(tokens.agent)
  }
  values.session = values.tab

  // Each ${separator} splits the template into groups, so empty groups collapse their separator.
  const groups = template
    .split('${separator}')
    .map((chunk) =>
      sanitizeWindowTitleText(
        chunk.replace(TOKEN_PATTERN, (whole, name: string) =>
          Object.hasOwn(values, name) ? values[name] : whole
        )
      )
    )
  const segments: string[] = []
  for (const group of groups) {
    if (group && group !== segments.at(-1)) {
      segments.push(group)
    }
  }
  return finalizeWindowTitle(segments.join(separator) || app)
}
