import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { openFileInBrowserTab } from '@/lib/file-preview'

/**
 * What the editor shows instead of "Binary file — cannot display" for an Office document.
 *
 * The inert message was accurate and useless: the file genuinely has no text form, but Orca can
 * now render it, and a reader who opened it in the editor is exactly the reader who wants that.
 */
export function EditorOfficeBinaryPlaceholder({
  filePath,
  worktreeId,
  fileName
}: {
  filePath: string
  worktreeId: string
  fileName: string
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <FileText className="size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.editor.officeBinaryPlaceholder',
          '{{name}} is an Office document.',
          { name: fileName }
        )}
      </p>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => openFileInBrowserTab({ filePath, worktreeId })}
      >
        {translate('auto.components.editor.officeOpenPreview', 'Open preview')}
      </Button>
    </div>
  )
}
