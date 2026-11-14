import type { Translate } from '@/i18n/use-translate'
import {
  FORK_MARKED_NAME_SLOTS,
  forkMarkedNameParts
} from '../../../../../shared/agent-session/agent-session-fork-name-order'

/** "Fork · <name>" as plain text in the locale's order, for titles and other text-only places. */
export function forkMarkedNameText(t: Translate, name: string): string {
  const mark = t('components.native-chat.fork.mark', 'Fork ·')
  return forkMarkedNameParts(
    t('components.native-chat.fork.markedName', '{{mark}} {{name}}', {
      ...FORK_MARKED_NAME_SLOTS,
      interpolation: { escapeValue: false }
    })
  )
    .map((part) => (part.kind === 'mark' ? mark : part.kind === 'name' ? name : part.text))
    .join('')
}
