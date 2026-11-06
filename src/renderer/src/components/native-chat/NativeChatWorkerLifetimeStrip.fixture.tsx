import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatWorkerLifetimeStrip } from './NativeChatWorkerLifetimeStrip'

// Mocks with the owner's copy; the countdown is frozen at 1:42.
function onComposer(text: string) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="native-chat-appearance bg-background py-3">
        <NativeChatWorkerLifetimeStrip
          text={text}
          keepOpenLabel="Keep open"
          onKeepOpen={() => {}}
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

export const workerRunning = onComposer(
  'Temporary orchestration worker · Closes 2 minutes after it finishes'
)
export const workerFinished = onComposer('Temporary orchestration worker finished · Closes in 1:42')
