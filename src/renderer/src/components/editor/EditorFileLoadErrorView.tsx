import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { displayIpcErrorMessage } from '@/lib/ipc-error'
import { isFileTooLargeCodeMessage } from '../../../../shared/file-write-disk-precondition'
import { WORKTREE_HOST_UNRESOLVED_CODE } from './editor-panel-content-types'

// Localize by machine code; stored English remains readable for logs without coupling upstream state checks to UI language.
function localizeFileLoadError(message: string, code: string | undefined): string {
  if (code === WORKTREE_HOST_UNRESOLVED_CODE) {
    return translate(
      'editor.fileLoad.hostUnresolved',
      "The host couldn't find this file's workspace. It may have been removed, or the host may not know about it yet. Retry, or close this tab from the tab strip."
    )
  }
  // Keep IPC wrappers in stored errors for classifiers; strip them only for display.
  const displayed = displayIpcErrorMessage(message) ?? message
  if (isFileTooLargeCodeMessage(displayed)) {
    return translate(
      'editor.fileLoad.remoteTooLarge',
      'This file is too large to open from its host.'
    )
  }
  return displayed
}

// Leave close to the tab strip: this view also serves synthetic conflict rows and cannot enforce pin, shared-reference or unsaved-change rules.
export function EditorFileLoadErrorView({
  message,
  code,
  onRetry
}: {
  message: string
  code?: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4">
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {translate('auto.components.editor.EditorContent.39f018b052', 'Unable to load file')}
          </div>
          <div className="mt-1 break-words">{localizeFileLoadError(message, code)}</div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.editor.EditorContent.2a512bb46a', 'Retry')}
          </Button>
        </div>
      </div>
    </div>
  )
}
