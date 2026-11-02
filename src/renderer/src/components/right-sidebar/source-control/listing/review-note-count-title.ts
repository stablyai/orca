import { translate } from '@/i18n/i18n'

export function reviewNoteCountTitle(count: number): string {
  return translate('auto.components.right.sidebar.SourceControl.noteCount', '{{count}} notes', {
    count,
    defaultValue_one: '{{count}} note'
  })
}
