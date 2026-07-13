import { translate } from '@/i18n/i18n'

// Why: the shared worktree-create runtime is also the CLI backend, so some of
// its errors carry CLI-flavored copy ("Pass an explicit --base...") or raw git
// stderr. Map the known ones to actionable GUI copy; unknown errors pass
// through verbatim.
const DEFAULT_BASE_REF_ERROR = /could not resolve a default base ref/i
// `git worktree add ... <base>` with a base ref the member repo lacks.
const INVALID_BASE_REF_ERROR = /fatal: invalid reference: (\S+)/i

export function formatMissionMemberError(error: string): string {
  if (DEFAULT_BASE_REF_ERROR.test(error)) {
    return translate(
      'auto.components.sidebar.MissionMemberErrorCopy.c8affe1f4b',
      'This repository has no commits or default branch yet. Make an initial commit (or set a default branch in Project Settings), then retry.'
    )
  }
  const invalidRef = INVALID_BASE_REF_ERROR.exec(error)
  if (invalidRef) {
    return translate(
      'auto.components.sidebar.MissionMemberErrorCopy.cf94215034',
      "The base branch {{value0}} doesn't exist in this project. Create it there or change the mission's base branch, then retry.",
      { value0: invalidRef[1] }
    )
  }
  return error
}
