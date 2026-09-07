import { NodeFileReadTooLargeError, readNodeFileWithinLimit } from './node-bounded-file-reader'
import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from './json-text-structure-limit'

export const EXTERNAL_AUTOMATION_JOBS_FILE_MAX_BYTES = 8 * 1024 * 1024
export const EXTERNAL_AUTOMATION_JOBS_MAX_ENTRIES = 10_000
export const EXTERNAL_AUTOMATION_JOBS_JSON_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 1_000_000,
  nestingDepth: 128
}

type ExternalAutomationJobsFileOptions = {
  allowRootArray: boolean
  structureLimits?: JsonTextStructureLimits
}

export async function readExternalAutomationJobsFile(
  filePath: string,
  options: ExternalAutomationJobsFileOptions
): Promise<unknown[]> {
  let buffer: Buffer
  try {
    const result = await readNodeFileWithinLimit(filePath, EXTERNAL_AUTOMATION_JOBS_FILE_MAX_BYTES)
    buffer = result.buffer
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new Error(
        `External automation jobs file exceeds the ${EXTERNAL_AUTOMATION_JOBS_FILE_MAX_BYTES / 1024 / 1024} MiB memory limit: ${filePath}`
      )
    }
    throw error
  }

  const serialized = buffer.toString('utf-8')
  assertJsonTextStructureWithinLimits(
    serialized,
    options.structureLimits ?? EXTERNAL_AUTOMATION_JOBS_JSON_LIMITS
  )
  const parsed = JSON.parse(serialized) as unknown
  const jobs =
    options.allowRootArray && Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.jobs)
        ? parsed.jobs
        : []
  if (jobs.length > EXTERNAL_AUTOMATION_JOBS_MAX_ENTRIES) {
    throw new Error(
      `External automation jobs file contains more than ${EXTERNAL_AUTOMATION_JOBS_MAX_ENTRIES.toLocaleString()} jobs and cannot be loaded safely: ${filePath}`
    )
  }
  return jobs
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
