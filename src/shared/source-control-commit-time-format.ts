import type { SourceControlCommitTimeFormat } from './ui-chrome-types'

export const DEFAULT_SOURCE_CONTROL_COMMIT_TIME_FORMAT =
  'hidden' satisfies SourceControlCommitTimeFormat

export function normalizeSourceControlCommitTimeFormat(
  value: unknown
): SourceControlCommitTimeFormat {
  return value === 'relative' || value === 'absolute'
    ? value
    : DEFAULT_SOURCE_CONTROL_COMMIT_TIME_FORMAT
}
