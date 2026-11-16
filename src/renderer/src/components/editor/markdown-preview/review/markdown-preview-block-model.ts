import React from 'react'
import { formatMarkdownReviewCardQuote } from '@/lib/editor/markdown/review-notes/markdown-review-notes'
import type {
  MarkdownPreviewBlockRange,
  MarkdownPreviewPositionNode
} from '../render-tree/markdown-preview-types'

export function getMarkdownPreviewBlockRange(
  node: MarkdownPreviewPositionNode | undefined
): MarkdownPreviewBlockRange | null {
  const startLine = node?.position?.start?.line
  const endLine = node?.position?.end?.line
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    return null
  }
  if (typeof startLine !== 'number' || typeof endLine !== 'number' || startLine < 1) {
    return null
  }
  return { startLine, endLine: Math.max(startLine, endLine) }
}

function getMarkdownPreviewReactText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (!node || typeof node === 'boolean') {
    return ''
  }
  if (Array.isArray(node)) {
    return node.map(getMarkdownPreviewReactText).join(' ')
  }
  if (!React.isValidElement(node)) {
    return ''
  }
  const props = node.props as { alt?: unknown; children?: React.ReactNode }
  if (typeof props.alt === 'string' && props.alt.trim()) {
    return props.alt
  }
  return getMarkdownPreviewReactText(props.children)
}

export function getMarkdownPreviewAnnotationQuote(node: React.ReactNode): string | undefined {
  return formatMarkdownReviewCardQuote(getMarkdownPreviewReactText(node))
}

export function isMarkdownPreviewTableBodyRow(
  node: MarkdownPreviewPositionNode | undefined
): boolean {
  return node?.children?.find((child) => child.tagName)?.tagName === 'td'
}

export function getMarkdownPreviewTableBodyRowRanges(
  node: MarkdownPreviewPositionNode | undefined
): MarkdownPreviewBlockRange[] {
  return (node?.children ?? [])
    .filter((section) => section.tagName === 'tbody')
    .flatMap((body) => body.children ?? [])
    .filter(isMarkdownPreviewTableBodyRow)
    .flatMap((row) => getMarkdownPreviewBlockRange(row) ?? [])
}

type MarkdownPreviewNoteLines = { startLine?: number; lineNumber: number }

function isMarkdownPreviewNoteWithin(
  note: MarkdownPreviewNoteLines,
  range: MarkdownPreviewBlockRange
): boolean {
  return range.startLine <= (note.startLine ?? note.lineNumber) && note.lineNumber <= range.endLine
}

export function isMarkdownPreviewNoteOwnedByRange(
  note: MarkdownPreviewNoteLines,
  range: MarkdownPreviewBlockRange
): boolean {
  const inRange = range.containedNotesOnly
    ? isMarkdownPreviewNoteWithin(note, range)
    : range.startLine <= note.lineNumber && note.lineNumber <= range.endLine
  return inRange && !range.nestedRanges?.some((nested) => isMarkdownPreviewNoteWithin(note, nested))
}

export function hasMarkdownPreviewNestedBlock(
  node: MarkdownPreviewPositionNode | undefined
): boolean {
  const blockTags = new Set(['p', 'pre', 'table', 'blockquote', 'ul', 'ol'])
  return Boolean(node?.children?.some((child) => child.tagName && blockTags.has(child.tagName)))
}
