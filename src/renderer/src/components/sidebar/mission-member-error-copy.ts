import { translate } from '@/i18n/i18n'

// Why: the shared worktree-create runtime is also the CLI backend, so some of
// its errors carry CLI-flavored copy ("Pass an explicit --base..."). Map the
// known ones to actionable GUI copy; unknown errors pass through verbatim.
const DEFAULT_BASE_REF_ERROR = /could not resolve a default base ref/i

export function formatMissionMemberError(error: string): string {
  if (DEFAULT_BASE_REF_ERROR.test(error)) {
    return translate(
      'auto.components.sidebar.MissionMemberErrorCopy.c8affe1f4b',
      'This repository has no commits or default branch yet. Make an initial commit (or set a default branch in Project Settings), then retry.'
    )
  }
  return error
}
