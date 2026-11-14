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
          Back
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
              ? 'Enter review instructions'
              : state.page === 'baseBranch'
                ? 'Search branches…'
                : state.page === 'commit'
                  ? 'Search commits…'
                  : 'Review changes',
          ...(state.page === 'custom'
            ? { onSubmit: (text: string) => submit(menu.submit(text)) }
            : {})
        }}
      />
    </>
  )
}
