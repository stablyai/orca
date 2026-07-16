import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import {
  normalizeNativeChatReportedFilePath,
  parseNativeChatReportedFileChangeCandidates
} from './native-chat-reported-file-change-parser'

export type NativeChatReportedFilePatch = {
  text: string
  truncated: boolean
}

type PatchSectionKind = 'apply' | 'git' | 'unified'

type PatchSection = {
  start: number
  end: number
  kind: PatchSectionKind
}

function boundedPatchText(
  value: string,
  maxChars: number,
  maxLines: number
): NativeChatReportedFilePatch {
  const sourceBounded = value.slice(0, Math.max(1, maxChars))
  const charBounded = sourceBounded.replace(/\r\n/g, '\n')
  let lineCount = 1
  let lineEnd = charBounded.length
  for (let index = 0; index < charBounded.length; index += 1) {
    if (charBounded[index] !== '\n') {
      continue
    }
    lineCount += 1
    if (lineCount > Math.max(1, maxLines)) {
      lineEnd = index
      break
    }
  }
  return {
    text: charBounded.slice(0, lineEnd),
    truncated: value.length > sourceBounded.length || lineEnd < charBounded.length
  }
}

function patchSections(lines: readonly string[]): PatchSection[] {
  const sections: PatchSection[] = []
  let current: Omit<PatchSection, 'end'> | null = null
  const finish = (end: number): void => {
    if (current) {
      sections.push({ ...current, end })
    }
  }

  for (const [index, line] of lines.entries()) {
    let nextKind: PatchSectionKind | null = null
    if (/^\*\*\* (?:Add|Update|Delete) File: /.test(line)) {
      nextKind = 'apply'
    } else if (line.startsWith('diff --git ')) {
      nextKind = 'git'
    } else if (line.startsWith('--- ') && current?.kind !== 'apply' && current?.kind !== 'git') {
      nextKind = 'unified'
    }
    if (!nextKind) {
      continue
    }
    finish(index)
    current = { start: index, kind: nextKind }
  }
  finish(lines.length)
  return sections
}

function sectionMatchesPath(sectionText: string, targetPath: string): boolean {
  const targetKey = normalizeRuntimePathForComparison(
    normalizeNativeChatReportedFilePath(targetPath)
  )
  return parseNativeChatReportedFileChangeCandidates(sectionText, 16).some((candidate) => {
    const keys = [candidate.path, candidate.previousPath]
      .filter((path): path is string => Boolean(path))
      .map((path) => normalizeRuntimePathForComparison(normalizeNativeChatReportedFilePath(path)))
    return keys.includes(targetKey)
  })
}

/** Select only the apply-patch or unified-diff section that belongs to a file.
 * Bounding happens before line splitting so tool output cannot inflate memory. */
export function extractNativeChatReportedFilePatch(
  value: string,
  targetPath: string,
  limits: { maxChars: number; maxLines: number }
): NativeChatReportedFilePatch | null {
  if (!value || !targetPath) {
    return null
  }
  const bounded = boundedPatchText(value, limits.maxChars, limits.maxLines)
  const lines = bounded.text.split('\n')
  const sections = patchSections(lines)
  for (const section of sections) {
    const text = lines.slice(section.start, section.end).join('\n')
    if (!sectionMatchesPath(text, targetPath)) {
      continue
    }
    return {
      text,
      // Only the final visible section can have been cut by the outer bound.
      truncated: bounded.truncated && section.end === lines.length
    }
  }
  return null
}
