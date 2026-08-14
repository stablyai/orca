import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import type { GitLineBlameResult } from '../../../../shared/git-line-blame-types'

/** Cap so a long commit subject can't run far past the code it annotates. */
const MAX_SUMMARY_LENGTH = 60

/** Why: a touch smaller than the code reads as annotation rather than source. */
const FONT_SCALE = 0.9

const INLINE_BLAME_WIDGET_ID = 'orca.inline-git-blame'

export type InlineBlameLabelParts = {
  author: string
  relativeDate: string
  summary: string
  isUncommitted: boolean
  uncommittedLabel: string
}

/**
 * End-of-line annotation text, GitLens style: `author, 3 months ago · summary`.
 *
 * Kept separate from the widget so the formatting is unit-testable without a
 * Monaco instance.
 */
export function buildInlineBlameLabel(parts: InlineBlameLabelParts): string {
  if (parts.isUncommitted) {
    return parts.uncommittedLabel
  }
  const who = [parts.author, parts.relativeDate].filter(Boolean).join(', ')
  const summary = truncateSummary(parts.summary)
  return [who, summary].filter(Boolean).join(' · ')
}

/** Why: keeps the inline style value short instead of a long float tail. */
function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Why: the configured family can be a single name with no fallback (`SF Mono`).
 * Monaco's own layer resolves that against the editor's stack, but a content
 * widget is a plain div — if the name doesn't resolve there it silently falls
 * back to the surrounding UI font, which is proportional, so the annotation
 * stops looking like code. Appending the generic keeps it monospace regardless.
 */
export function withMonospaceFallback(fontFamily: string): string {
  const families = fontFamily
    .split(',')
    .map((family) => family.trim())
    .filter(Boolean)
  if (families.some((family) => family.toLowerCase() === 'monospace')) {
    return families.join(', ')
  }
  return [...families, 'monospace'].join(', ')
}

function truncateSummary(summary: string): string {
  const trimmed = summary.trim()
  if (trimmed.length <= MAX_SUMMARY_LENGTH) {
    return trimmed
  }
  return `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1).trimEnd()}…`
}

/**
 * Where the annotation hangs: just past the last character of `line`.
 *
 * Returns null when the line is gone — a blame reply can land after the buffer
 * shrank, and Monaco throws on a position it cannot resolve.
 */
export function inlineBlamePosition(
  model: editor.ITextModel,
  line: number
): { lineNumber: number; column: number } | null {
  const lineCount = model.getLineCount()
  if (!Number.isInteger(line) || line < 1 || line > lineCount) {
    return null
  }
  return { lineNumber: line, column: model.getLineMaxColumn(line) }
}

export type BlameLabelInput = {
  blame: GitLineBlameResult
  relativeDate: string
  uncommittedLabel: string
}

export function inlineBlameLabelFor(input: BlameLabelInput): string {
  return buildInlineBlameLabel({
    author: input.blame.author,
    relativeDate: input.relativeDate,
    summary: input.blame.summary,
    isUncommitted: input.blame.isUncommitted,
    uncommittedLabel: input.uncommittedLabel
  })
}

/**
 * Annotation renderer for the cursor line.
 *
 * Why a content widget rather than an `after` decoration: injected text is part
 * of the line for layout, so with word wrap on a long annotation pushes itself
 * (and sometimes the code) onto another visual row. A widget is positioned, not
 * laid out, so the annotation always sits on the same row as the line it
 * describes and can never reflow the source.
 */
export class InlineBlameWidget {
  private readonly domNode: HTMLElement
  private position: { lineNumber: number; column: number } | null = null
  private attached = false

  constructor(private readonly host: editor.IStandaloneCodeEditor) {
    this.domNode = document.createElement('div')
    this.domNode.className = 'monaco-inline-blame'
  }

  getId(): string {
    return INLINE_BLAME_WIDGET_ID
  }

  getDomNode(): HTMLElement {
    return this.domNode
  }

  getPosition(): editor.IContentWidgetPosition | null {
    if (!this.position) {
      return null
    }
    return {
      position: this.position,
      // Why EXACT: ABOVE/BELOW would lift the annotation off the row it
      // describes, which is the whole point of anchoring it to the line end.
      preference: [monaco.editor.ContentWidgetPositionPreference.EXACT]
    }
  }

  show(label: string, position: { lineNumber: number; column: number }): void {
    this.domNode.textContent = label
    this.position = position
    this.matchEditorTextMetrics()
    if (!this.attached) {
      this.host.addContentWidget(this)
      this.attached = true
      return
    }
    this.host.layoutContentWidget(this)
  }

  /**
   * Why: a content widget is positioned at the top of its line but sized by its
   * own content, so with the editor's line height left unapplied the text sat
   * centred in a box of a different height and drifted off the code's baseline.
   * Re-read on every show so font zoom and theme changes stay matched.
   */
  private matchEditorTextMetrics(): void {
    const fontInfo = this.host.getOption?.(monaco.editor.EditorOption.fontInfo)
    if (!fontInfo) {
      return
    }
    const { lineHeight, fontFamily, fontSize } = fontInfo
    // Why: the box keeps the full line height even though the text is smaller,
    // so the annotation still occupies exactly one row and stays on the line.
    this.domNode.style.height = `${lineHeight}px`
    this.domNode.style.lineHeight = `${lineHeight}px`
    this.domNode.style.fontFamily = withMonospaceFallback(fontFamily)
    this.domNode.style.fontSize = `${roundToTenth(fontSize * FONT_SCALE)}px`
  }

  hide(): void {
    if (!this.attached) {
      return
    }
    this.host.removeContentWidget(this)
    this.attached = false
    this.position = null
  }

  dispose(): void {
    this.hide()
  }
}
