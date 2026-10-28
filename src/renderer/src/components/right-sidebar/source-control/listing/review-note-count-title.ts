import { translate } from '@/i18n/i18n'

export function reviewNoteCountTitle(count: number): string {
  return translate('sourceControl.noteCount', '{{count}} notes', {
    count,
    defaultValue_one: '{{count}} note'
  })
}
