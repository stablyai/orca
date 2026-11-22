import { defineFixture } from '../../component-fixtures/component-fixture'
import { BotChatAutoCloseStripView } from './BotChatAutoCloseStrip'

// The owner's copy, with the clock frozen at 3:40 PM.
function onComposer(text: string, actions: readonly string[]) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        <BotChatAutoCloseStripView
          text={text}
          actions={actions.map((label) => ({ label, onClick: () => {} }))}
        />
        <div className="px-3 pt-2 sm:px-4">
          <div className="mx-auto h-20 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
            Ask anything, @ to mention files, / for commands
          </div>
        </div>
      </div>
    )
  })
}

export const counting = onComposer(
  'All items here are done or canceled. History is kept · Closes at 3:42 PM (in 2 min)',
  ['Keep open', 'Close now']
)
export const held = onComposer('Closing paused while this chat is open or has an unsent message.', [
  'Keep open',
  'Close now'
])
export const kept = onComposer('Kept open until new work finishes.', ['Close now'])
