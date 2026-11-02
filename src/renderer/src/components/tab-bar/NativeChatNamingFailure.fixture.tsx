import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatNamingErrorBlock } from './NativeChatNamingFailure'

export const failed = defineFixture({
  width: 288,
  render: () => (
    <div className="w-64 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground">
      <NativeChatNamingErrorBlock
        naming={{
          message: 'The selected model is not supported.',
          canRegenerate: true,
          regenerating: false,
          regenerate: () => {},
          dialogOpen: false,
          setDialogOpen: () => {},
          readFullOutput: async () => null
        }}
      />
    </div>
  )
})
