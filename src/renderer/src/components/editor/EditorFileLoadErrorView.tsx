import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  isOverridableFileTooLarge,
  parseFileTooLargeMessage
} from '../../../../shared/editor-file-read-limit'
import { LargeFileFallback } from './LargeFileFallback'

export function EditorFileLoadErrorView({
  message,
  filePath,
  onRetry,
  onOpenAnyway
}: {
  message: string
  filePath: string
  onRetry: () => void
  onOpenAnyway?: () => void
}): React.JSX.Element {
  // Why: a size refusal is deterministic, so the generic retry box is a dead end.
  const tooLarge = parseFileTooLargeMessage(message)
  if (tooLarge) {
    // Why: the override is only offered where the refusal says it could land —
    // an unhonoured transport or a limit already at the ceiling is a button that
    // silently refuses again.
    return (
      <LargeFileFallback
        filePath={filePath}
        detail={tooLarge}
        onOpenAnyway={isOverridableFileTooLarge(tooLarge) ? onOpenAnyway : undefined}
      />
    )
  }

  return (
    <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
      <div className="flex max-w-xl items-start gap-3 rounded-md border border-border bg-background p-4">
        <AlertCircle className="mt-0.5 size-4 flex-shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-foreground">
            {translate('auto.components.editor.EditorContent.39f018b052', 'Unable to load file')}
          </div>
          <div className="mt-1 break-words">{message}</div>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            {translate('auto.components.editor.EditorContent.2a512bb46a', 'Retry')}
          </Button>
        </div>
      </div>
    </div>
  )
}
