import type { SourceControlActionError } from '../sync/action-error'

export function BranchSwitchWarning({ error }: { error: SourceControlActionError | null }) {
  if (error?.kind !== 'switch_branch') {
    return null
  }
  return (
    <p role="alert" className="px-3 py-2 text-xs text-destructive">
      {error.message}
    </p>
  )
}
