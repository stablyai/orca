import { toast } from 'sonner'
import type { MarkdownDocument } from '../../../../shared/types'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import { getCreatableMarkdownDocLinkTarget } from './markdown-doc-links'

type MissingDocLinkToastOptions = {
  onCreate: (target: string) => Promise<void>
  target: string
}

export function showInvalidMarkdownDocLinkTargetToast(): void {
  toast.error(
    translate(
      'auto.components.editor.markdown.doc.link.toasts.3ac54dda7f',
      'Cannot create note from this link'
    )
  )
}

export function showCreatedMarkdownDocLinkToast(relativePath: string): void {
  toast.success(
    translate('auto.components.editor.markdown.doc.link.toasts.86a480c022', 'Note created'),
    { description: relativePath }
  )
}

export function showMissingMarkdownDocLinkCreateToast({
  onCreate,
  target
}: MissingDocLinkToastOptions): void {
  const creatable = getCreatableMarkdownDocLinkTarget(target)
  if (!creatable) {
    showInvalidMarkdownDocLinkTargetToast()
    return
  }

  toast.info(
    translate('auto.components.editor.markdown.doc.link.toasts.dd5af2ab74', 'Note not found'),
    {
      description: creatable.relativePath,
      action: {
        label: translate(
          'auto.components.editor.markdown.doc.link.toasts.53b9d723ef',
          'Create note'
        ),
        onClick: () => {
          void onCreate(target).catch((err) => {
            toast.error(
              extractIpcErrorMessage(
                err,
                translate(
                  'auto.components.editor.markdown.doc.link.toasts.e3cfe7a2d5',
                  'Failed to create note'
                )
              )
            )
          })
        }
      }
    }
  )
}

export function showAmbiguousMarkdownDocLinkToast(matches: MarkdownDocument[]): void {
  const previewMatches = matches
    .slice(0, 3)
    .map((match) => match.relativePath)
    .join(', ')
  const overflowCount = matches.length - 3
  const overflowSuffix = translate(
    'auto.components.editor.markdown.doc.link.toasts.2f55cdad12',
    '+{{value0}} more',
    { value0: overflowCount }
  )
  const description = overflowCount > 0 ? `${previewMatches}, ${overflowSuffix}` : previewMatches

  toast.warning(
    translate(
      'auto.components.editor.markdown.doc.link.toasts.0c8765cd46',
      'Document link is ambiguous'
    ),
    { description }
  )
}
