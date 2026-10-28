import { translate } from '@/i18n/i18n'

export function reviewNoteCountTitle(count: number): string {
  return count === 1
    ? translate('auto.components.right.sidebar.SourceControl.noteCountSingular', '{{count}} note', {
        count
      })
    : translate('auto.components.right.sidebar.SourceControl.noteCountPlural', '{{count}} notes', {
        count
      })
}
