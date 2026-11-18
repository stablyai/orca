import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function reviewNoteCountTitle(count: number, t: Translate = translate): string {
  return t('auto.components.right.sidebar.SourceControl.noteCount', '{{count}} notes', {
    count,
    defaultValue_one: '{{count}} note'
  })
}
