import { Loader2 } from 'lucide-react'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type AddRepoSpaceConflictView = {
  projectName: string
  sourceSpaceName: string
  targetSpaceName: string
}

export function AddRepoSpaceConflictStep({
  conflict,
  error,
  isResolving,
  onCancel,
  onMove,
  onOpen
}: {
  conflict: AddRepoSpaceConflictView
  error: string | null
  isResolving: boolean
  onCancel: () => void
  onMove: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {translate(
            'auto.components.sidebar.AddRepoSpaceConflictStep.c69b0787ba',
            'Project is in “{{spaceName}}”',
            { spaceName: conflict.sourceSpaceName }
          )}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {translate(
            'auto.components.sidebar.AddRepoSpaceConflictStep.9c68432d3d',
            'Move “{{projectName}}” to “{{targetSpaceName}}” to show it here. It will no longer appear in “{{sourceSpaceName}}”; its files and workspaces won’t change.',
            conflict
          )}
        </DialogDescription>
      </DialogHeader>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs"
          disabled={isResolving}
          onClick={onCancel}
        >
          {translate('auto.components.sidebar.AddRepoSpaceConflictStep.92d91b0399', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-xs"
          disabled={isResolving}
          onClick={onOpen}
        >
          {translate(
            'auto.components.sidebar.AddRepoSpaceConflictStep.fda24641cc',
            'Open in {{spaceName}}',
            { spaceName: conflict.sourceSpaceName }
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          className="text-xs"
          disabled={isResolving}
          autoFocus
          onClick={onMove}
        >
          {isResolving ? <Loader2 className="animate-spin" /> : null}
          {translate(
            'auto.components.sidebar.AddRepoSpaceConflictStep.a6a5fca1aa',
            'Move to {{spaceName}}',
            { spaceName: conflict.targetSpaceName }
          )}
        </Button>
      </DialogFooter>
    </>
  )
}
