import { basename, dirname, extname, isAbsolute, join } from 'node:path'

export const SAFE_THREAD_ID = /^[A-Za-z0-9-]{1,64}$/

export function normalizedTranscriptPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

// Why: Codex files each rollout under its OWN local start date, so a session running past midnight spawns children into a sibling day directory.
function childDayDirectory(parentPath: string, startedAt: number): string | undefined {
  const dayDir = dirname(parentPath)
  const monthDir = dirname(dayDir)
  const yearDir = dirname(monthDir)
  if (
    !/^\d{2}$/.test(basename(dayDir)) ||
    !/^\d{2}$/.test(basename(monthDir)) ||
    !/^\d{4}$/.test(basename(yearDir)) ||
    !Number.isFinite(startedAt)
  ) {
    return undefined
  }
  const startedOn = new Date(startedAt)
  if (Number.isNaN(startedOn.getTime())) {
    return undefined
  }
  const pad = (value: number): string => String(value).padStart(2, '0')
  return join(
    dirname(yearDir),
    String(startedOn.getFullYear()).padStart(4, '0'),
    pad(startedOn.getMonth() + 1),
    pad(startedOn.getDate())
  )
}

export function childTranscriptDirectories(parentPath: string, startedAt: number): string[] {
  const parentDir = dirname(parentPath)
  const childDir = childDayDirectory(parentPath, startedAt)
  return childDir && childDir !== parentDir ? [parentDir, childDir] : [parentDir]
}

export function resolveChildTranscript(
  parentPath: string,
  threadId: string,
  startedAt: number,
  entriesFor: (directory: string) => string[] | undefined
): string | undefined {
  if (!SAFE_THREAD_ID.test(threadId)) {
    return undefined
  }
  const suffix = `-${threadId}.jsonl`
  for (const directory of childTranscriptDirectories(parentPath, startedAt)) {
    const fileName = entriesFor(directory)?.find((entry) => entry.endsWith(suffix))
    if (fileName) {
      return join(directory, fileName)
    }
  }
  return undefined
}
