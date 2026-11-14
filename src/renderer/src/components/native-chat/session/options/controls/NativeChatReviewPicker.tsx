import { useTranslate } from '@/i18n/use-translate'
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import type { NativeChatReviewMenu } from '../../../../../../../shared/native-chat/input/native-chat-review-menu'
import { NativeChatModelCombobox } from './NativeChatModelCombobox'
export function ReviewPicker({
  menu,
  onClose
}: {
  menu: NativeChatReviewMenu
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useSyncExternalStore(menu.subscribe, menu.getSnapshot)
  const submit = (run: Promise<boolean>) => {
    void run.then((accepted) => {
      if (accepted) {
        onClose()
      }
    })
  }
  return (
    <>
      {state.page !== 'review' && (
        <Button variant="ghost" size="xs" onClick={menu.back}>
          {t('common.back', 'Back')}
        </Button>
      )}
      <NativeChatModelCombobox
        key={state.page}
        choices={state.choices}
        currentValue={undefined}
        readOnly={false}
        readOnlyReason={null}
        busy={state.busy}
        onSelect={(value) => submit(menu.select(value))}
        review={{
          label:
            state.page === 'custom'
              ? t('nativeChat.review.instructions', 'Enter review instructions')
              : state.page === 'baseBranch'
                ? t('nativeChat.review.searchBranches', 'Search branches…')
                : state.page === 'commit'
                  ? t('nativeChat.review.searchCommits', 'Search commits…')
                  : t('nativeChat.review.title', 'Review changes'),
          ...(state.page === 'custom'
            ? { onSubmit: (text: string) => submit(menu.submit(text)) }
            : {})
        }}
      />
    </>
  )
}
