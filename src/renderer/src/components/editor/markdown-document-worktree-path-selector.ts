import { getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'

export function selectMarkdownDocumentWorktreePath(
  state: Pick<AppState, 'worktreesByRepo'>,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  return getWorktreeMapFromState(state).get(worktreeId)?.path ?? null
}
