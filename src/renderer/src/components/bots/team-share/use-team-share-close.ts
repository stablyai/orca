// Closing the Share dialog with picks not yet shared asks first, so nobody is left out by accident.
import { useRef } from 'react'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import type { TeamShareSuggestion } from './bot-team-share-people'
import { stagedName } from './BotTeamShareStagedChip'

/** ✕, Esc, a press outside and Done: closes at once with nothing picked or typed, else on Discard.
 *  Never while `sharing`: Share's own confirmations sit on top and read as a press outside. */
export function useTeamShareClose(
  staged: readonly TeamShareSuggestion[],
  query: string,
  onClose: () => void,
  sharing: boolean
): () => void {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  // A press on the confirm also reads as outside the Share dialog; one ask at a time.
  const asking = useRef(false)
  return () => {
    if (sharing) {
      return
    }
    const typed = query.trim()
    const names = staged.length > 0 ? staged.map(stagedName) : typed ? [typed] : []
    if (names.length === 0) {
      onClose()
      return
    }
    if (asking.current) {
      return
    }
    asking.current = true
    void confirm({
      title:
        names.length === 1
          ? t('bots.teamShare.discardTitleOne', 'Discard invite?')
          : t('bots.teamShare.discardTitleMany', 'Discard {{count}} invites?', {
              count: names.length
            }),
      description:
        names.length === 1
          ? t('bots.teamShare.discardOne', '{{name}} won’t get access.', { name: names[0] })
          : t('bots.teamShare.discardMany', 'These people won’t get access.'),
      confirmLabel: t('bots.teamShare.discard', 'Discard'),
      cancelLabel: t('bots.teamShare.keepEditing', 'Keep editing')
    }).then((discard) => {
      asking.current = false
      if (discard) {
        onClose()
      }
    })
  }
}
