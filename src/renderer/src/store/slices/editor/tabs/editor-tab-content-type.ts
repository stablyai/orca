import type { Tab } from '../../../../../../shared/tab-types'

export function isEditorTabContentType(contentType: Tab['contentType']): boolean {
  return (
    contentType === 'editor' ||
    contentType === 'diff' ||
    contentType === 'conflict-review' ||
    contentType === 'check-details'
  )
}
