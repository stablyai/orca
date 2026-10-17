import { translate } from '@/i18n/i18n'

// Why whole sentences per count: the plural ending used to travel as an
// interpolation value, which glued an English "s" onto translated nouns.
export function reviewNoteCountTitle(count: number): string {
  return count === 1
    ? translate('auto.components.right.sidebar.SourceControl.noteCountSingular', '{{count}} note', {
        count
      })
    : translate('auto.components.right.sidebar.SourceControl.noteCountPlural', '{{count}} notes', {
        count
      })
}
