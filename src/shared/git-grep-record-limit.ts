export const GIT_GREP_MAX_RECORD_BYTES = 8 * 1024 * 1024

export class GitGrepRecordCapacityError extends Error {
  readonly code = 'git_grep_record_capacity'

  constructor() {
    super('Git search record exceeds the 8 MiB limit.')
    this.name = 'GitGrepRecordCapacityError'
  }
}
