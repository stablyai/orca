import { defineFixture } from '@/component-fixtures/component-fixture'
import { Button } from '@/components/ui/button'
import { NativeChatComposerTabStrip } from './NativeChatComposerTabStrip'

export const handedOffToBot = defineFixture({
  width: 640,
  render: () => (
    <div className="native-chat-appearance bg-background py-3">
      <NativeChatComposerTabStrip>
        <p className="min-w-0 flex-1 truncate py-1 tabular-nums">
          Handed to Atlas · Stays open · You can still type here
        </p>
        <Button type="button" variant="ghost" size="xs" className="shrink-0">
          Remove from Atlas
        </Button>
      </NativeChatComposerTabStrip>
      <div className="px-3 pt-2 sm:px-4">
        <div className="mx-auto h-20 w-full max-w-(--chat-content-max-width) rounded-xl border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          Ask anything, @ to mention files, / for commands
        </div>
      </div>
    </div>
  )
})
