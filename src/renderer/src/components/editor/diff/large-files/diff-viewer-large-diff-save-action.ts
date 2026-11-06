import { translate } from '@/i18n/i18n'

type DiffViewerLargeDiffSaveActionInput = {
  editable?: boolean
  modifiedContent: string
  onSave?: (content: string) => void
  saveContentAvailable?: boolean
}

export function getDiffViewerLargeDiffSaveAction({
  editable,
  modifiedContent,
  onSave,
  saveContentAvailable = true
}: DiffViewerLargeDiffSaveActionInput):
  | { label: string; description: string; onClick: () => void }
  | undefined {
  // IPC can prune oversized text bodies; allow fallback saves only when modified content is complete.
  if (!editable || !onSave || !saveContentAvailable) {
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
