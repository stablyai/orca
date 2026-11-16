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

/** A fork tab's hover-card line naming its source, marked when the source is itself a fork;
 *  `source` is undefined when the host has said nothing of that chat. */
export function forkSourceTooltipText(
  t: Translate,
  source: { name: string | null; forked: boolean } | undefined,
  unnamedLabel: string
): string {
  if (!source) {
    return t('components.native-chat.fork.unknownSourceTooltip', 'Fork of another chat')
  }
  const name = source.name ?? unnamedLabel
  return t('components.native-chat.fork.sourceTooltip', 'Fork of {{name}}', {
    name: source.forked ? forkMarkedNameText(t, name) : name,
    interpolation: { escapeValue: false }
  })
}
