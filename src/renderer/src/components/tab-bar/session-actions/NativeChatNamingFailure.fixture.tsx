import { defineFixture } from '../../../component-fixtures/component-fixture'
import { NativeChatNamingErrorBlock, NativeChatNamingFailedDialog } from './NativeChatNamingFailure'

export const failed = defineFixture({
  width: 288,
  render: () => (
    <div className="w-64 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground">
      <NativeChatNamingErrorBlock
        naming={{
          message: 'The selected model is not supported.',
          executionHostId: null,
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

export const failedDialog = defineFixture({
  width: 640,
  render: () => (
    <NativeChatNamingFailedDialog
      chatName="Fix the login flow"
      naming={{
        message: 'No chat-name agent can run in this workspace.',
        executionHostId: null,
        canRegenerate: true,
        regenerating: false,
        regenerate: () => {},
        dialogOpen: true,
        setDialogOpen: () => {},
        readFullOutput: async () => null
      }}
    />
  )
})

export const timedOut = defineFixture({
  width: 288,
  render: () => (
    <div className="w-64 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground">
      <NativeChatNamingErrorBlock
        naming={{
          message: 'Generation timed out after 60s.',
          executionHostId: null,
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
