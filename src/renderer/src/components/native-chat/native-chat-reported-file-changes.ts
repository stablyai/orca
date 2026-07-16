import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type {
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from '../../../../shared/native-chat-types'
import {
  normalizeNativeChatReportedFilePath,
  parseNativeChatReportedFileChangeCandidates,
  type NativeChatReportedFileChangeCandidate,
  type NativeChatReportedFileChangeStatus
} from './native-chat-reported-file-change-parser'

export type { NativeChatReportedFileChangeStatus } from './native-chat-reported-file-change-parser'

export const MAX_REPORTED_FILE_CHANGE_TEXT_CHARS = 64_000
export const MAX_REPORTED_FILE_CHANGE_TEXT_LINES = 4_000
export const MAX_REPORTED_FILE_CHANGES = 200
const MAX_REPORTED_FILE_PATH_CHARS = 4_096

export type NativeChatReportedFileChange = {
  path: string
  status: NativeChatReportedFileChangeStatus
  previousPath?: string
  binary: boolean
  stepIndexes: number[]
}

export type NativeChatReportedFileChangeCollection = {
  changes: NativeChatReportedFileChange[]
  truncated: boolean
}

export type NativeChatReportedFileChangeStep = {
  call: NativeChatToolCallBlock | null
  result: NativeChatToolResultBlock | null
}

type ScanBudget = {
  remainingChars: number
  remainingLines: number
  truncated: boolean
}

const EDIT_TOOL_NAMES = new Set(['edit', 'multiedit', 'write', 'strreplace', 'applypatch'])

/** Summarize transcript-reported changes from successful editing results. The
 * truncation bit makes bounded evidence explicit instead of implying completeness. */
export function collectNativeChatReportedFileChanges(
  steps: readonly NativeChatReportedFileChangeStep[]
): NativeChatReportedFileChangeCollection {
  const changes = new Map<string, NativeChatReportedFileChange>()
  const scanBudget: ScanBudget = {
    remainingChars: MAX_REPORTED_FILE_CHANGE_TEXT_CHARS,
    remainingLines: MAX_REPORTED_FILE_CHANGE_TEXT_LINES,
    truncated: false
  }

  for (const [stepIndex, { call, result }] of steps.entries()) {
    if (!call || !result || !isSuccessfulResult(result)) {
      continue
    }
    const toolName = normalizeNativeChatReportedToolName(call.name)
    if (!EDIT_TOOL_NAMES.has(toolName)) {
      continue
    }

    const candidates = changesFromSuccessfulStep(toolName, call.input, result.output, scanBudget)
    for (const candidate of candidates) {
      const path = usablePath(candidate.path)
      const previousPath = candidate.previousPath ? usablePath(candidate.previousPath) : null
      if (!path || (candidate.previousPath && !previousPath)) {
        scanBudget.truncated = true
        continue
      }
      const updatesExisting =
        changes.has(pathKey(path)) || Boolean(previousPath && changes.has(pathKey(previousPath)))
      if (!updatesExisting && changes.size >= MAX_REPORTED_FILE_CHANGES) {
        scanBudget.truncated = true
        continue
      }
      mergeCandidate(changes, candidate, stepIndex)
    }
  }

  return { changes: [...changes.values()], truncated: scanBudget.truncated }
}

function isSuccessfulResult(result: NativeChatToolResultBlock): boolean {
  if (result.outcome !== undefined) {
    return result.outcome === 'success'
  }
  return result.isError !== true
}

function changesFromSuccessfulStep(
  toolName: string,
  input: unknown,
  output: string,
  scanBudget: ScanBudget
): NativeChatReportedFileChangeCandidate[] {
  const candidates: NativeChatReportedFileChangeCandidate[] = []
  const directPath = readNativeChatReportedFileInputPath(input)
  if (directPath) {
    // Write may replace an existing file; only patch metadata proves an addition.
    candidates.push({ path: directPath, status: 'modified' })
  }

  if (toolName === 'applypatch') {
    const patch = readNativeChatReportedFilePatchText(input)
    if (patch) {
      candidates.push(...scanPatchText(patch, scanBudget))
    }
  }
  candidates.push(...scanPatchText(output, scanBudget))
  return candidates
}

function scanPatchText(value: string, budget: ScanBudget): NativeChatReportedFileChangeCandidate[] {
  const bounded = takeScanBudget(value, budget)
  if (!bounded) {
    return []
  }
  const candidates = parseNativeChatReportedFileChangeCandidates(
    bounded,
    MAX_REPORTED_FILE_CHANGES + 1
  )
  if (candidates.length > MAX_REPORTED_FILE_CHANGES) {
    budget.truncated = true
    return candidates.slice(0, MAX_REPORTED_FILE_CHANGES)
  }
  return candidates
}

function takeScanBudget(value: string, budget: ScanBudget): string {
  if (!value) {
    return ''
  }
  if (budget.remainingChars <= 0 || budget.remainingLines <= 0) {
    budget.truncated = true
    return ''
  }

  const charBounded = value.slice(0, budget.remainingChars)
  let usedLines = 1
  let end = charBounded.length
  for (let index = 0; index < charBounded.length; index += 1) {
    if (charBounded[index] !== '\n') {
      continue
    }
    usedLines += 1
    if (usedLines > budget.remainingLines) {
      usedLines -= 1
      end = index
      break
    }
  }
  const scanned = charBounded.slice(0, end)
  const charTruncated = charBounded.length < value.length && end === charBounded.length
  const bounded =
    charTruncated && !scanned.endsWith('\n')
      ? scanned.slice(0, Math.max(0, scanned.lastIndexOf('\n') + 1))
      : scanned
  budget.remainingChars -= scanned.length
  budget.remainingLines -= usedLines
  if (value.length > bounded.length) {
    budget.truncated = true
  }
  return bounded
}

function mergeCandidate(
  changes: Map<string, NativeChatReportedFileChange>,
  candidate: NativeChatReportedFileChangeCandidate,
  stepIndex: number
): void {
  const path = usablePath(candidate.path)
  const candidatePreviousPath = candidate.previousPath ? usablePath(candidate.previousPath) : null
  if (!path) {
    return
  }

  let nextStatus = candidate.status
  let previousPath = candidatePreviousPath ?? undefined
  let renamedFrom: NativeChatReportedFileChange | undefined
  if (candidatePreviousPath) {
    renamedFrom = changes.get(pathKey(candidatePreviousPath))
    if (renamedFrom) {
      changes.delete(pathKey(candidatePreviousPath))
      previousPath = renamedFrom.previousPath ?? candidatePreviousPath
      if (renamedFrom.status === 'added') {
        nextStatus = 'added'
        previousPath = undefined
      }
    }
  }

  const key = pathKey(path)
  const current = changes.get(key)
  const status = preservedStatus(current?.status, nextStatus)
  const retainedPreviousPath =
    status === 'renamed' ? (current?.previousPath ?? previousPath) : undefined
  changes.set(key, {
    path: current?.path ?? path,
    status,
    ...(retainedPreviousPath ? { previousPath: retainedPreviousPath } : {}),
    binary: Boolean(current?.binary || renamedFrom?.binary || candidate.binary),
    stepIndexes: mergeStepIndexes(current?.stepIndexes, renamedFrom?.stepIndexes, stepIndex)
  })
}

function preservedStatus(
  current: NativeChatReportedFileChangeStatus | undefined,
  next: NativeChatReportedFileChangeStatus
): NativeChatReportedFileChangeStatus {
  if (next !== 'modified') {
    return next
  }
  return current === 'added' || current === 'renamed' ? current : next
}

function mergeStepIndexes(
  current: readonly number[] | undefined,
  renamedFrom: readonly number[] | undefined,
  stepIndex: number
): number[] {
  return [...new Set([...(current ?? []), ...(renamedFrom ?? []), stepIndex])]
}

function usablePath(value: string): string | null {
  const path = normalizeNativeChatReportedFilePath(value)
  if (
    !path ||
    path.length > MAX_REPORTED_FILE_PATH_CHARS ||
    path.includes('\0') ||
    path.includes('\r') ||
    path.includes('\n')
  ) {
    return null
  }
  try {
    encodeURIComponent(path)
  } catch {
    return null
  }
  return path
}

export function readNativeChatReportedFileInputPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') {
    return null
  }
  const value = input as Record<string, unknown>
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'target_file',
    'targetFile'
  ]) {
    if (typeof value[key] === 'string') {
      const path = usablePath(value[key])
      if (path) {
        return path
      }
    }
  }
  return null
}

export function readNativeChatReportedFilePatchText(input: unknown): string | null {
  if (typeof input === 'string') {
    return input
  }
  if (!input || typeof input !== 'object') {
    return null
  }
  const value = input as Record<string, unknown>
  for (const key of ['patch', 'patch_text', 'input', 'diff']) {
    if (typeof value[key] === 'string') {
      return value[key]
    }
  }
  return null
}

export function normalizeNativeChatReportedToolName(name: string): string {
  const leaf = name.trim().split(/[.:/]/).at(-1) ?? ''
  return leaf.toLowerCase().replace(/[-_\s]/g, '')
}

function pathKey(path: string): string {
  return normalizeRuntimePathForComparison(path)
}
