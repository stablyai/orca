import { translate } from '@/i18n/i18n'

type DiffViewerLargeDiffSaveActionInput = {
  editable?: boolean
  modifiedContent: string
  onSave?: (content: string) => void
}

export function getDiffViewerLargeDiffSaveAction({
  editable,
  modifiedContent,
  onSave
}: DiffViewerLargeDiffSaveActionInput):
  | { label: string; description: string; onClick: () => void }
  | undefined {
  if (!editable || !onSave) {
    return undefined
  }

  return {
    label: translate('auto.components.editor.DiffViewer.b5675b0694', 'Save'),
    description: translate(
      'auto.components.editor.DiffViewer.593f2193f6',
      'This draft crossed the safe display limit, but it can still be saved.'
    ),
    onClick: () => onSave(modifiedContent)
  }
}
