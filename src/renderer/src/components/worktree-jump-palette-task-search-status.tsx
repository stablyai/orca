import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function WorktreeJumpPaletteTaskSearchStatus({
  loading,
  failures,
  onRetry
}: {
  loading: boolean
  failures: readonly string[]
  onRetry: () => void
}) {
  if (!loading && !failures.length) {
    return null
  }
  return (
    <div className="mx-3 my-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
      {loading ? (
        <>
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>{translate('worktreeJumpPalette.taskSearchLoading', 'Searching tasks…')}</span>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">
            {translate(
              'worktreeJumpPalette.taskSearchFailed',
              'Some task sources could not be searched'
            )}
            : {failures.join(', ')}
          </span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {translate('worktreeJumpPalette.taskSearchRetry', 'Retry')}
          </Button>
        </>
      )}
    </div>
  )
}
