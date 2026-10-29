import { translate } from '@/i18n/i18n'

export function reviewNoteCountTitle(count: number): string {
  return count === 1
    ? translate('auto.components.right.sidebar.SourceControl.noteCount_one', '{{count}} note', {
        count
      })
    : translate('auto.components.right.sidebar.SourceControl.noteCount_other', '{{count}} notes', {
        count
      })
}
