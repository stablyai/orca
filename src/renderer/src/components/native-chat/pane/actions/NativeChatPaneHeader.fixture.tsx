import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'

export const splitShortcut = defineFixture({
  width: 420,
  render: () => (
    <div className="relative bg-background p-6 pb-20">
      <NativeChatPaneHeader
        tabId="fixture-chat"
        worktreeId="fixture-workspace"
        groupId="fixture-group"
        nativeChat={{ sessionId: 'fixture-session', agent: undefined }}
        focused
        colorScheme={undefined}
      />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Split Chat Right"]')?.focus()
  }
})

export const settings = defineFixture({
  ...splitShortcut,
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="Chat settings"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})

const toolbarStore = {
  folderWorkspaces: [makeFolderWorkspace({ id: 'checkout', folderPath: '/projects/acme/app' })]
}
const toolbarRender = (focused = true) => (
  <div className="native-chat-appearance relative h-40 overflow-hidden bg-chat-pane text-chat-foreground">
    <NativeChatPaneHeader
      tabId="checkout-chat"
      worktreeId="folder:checkout"
      groupId="checkout-group"
      nativeChat={{ sessionId: 'codex-checkout', agent: 'codex' }}
      focused={focused}
      colorScheme={undefined}
      handOff={{ open: () => {}, disabled: false }}
    />
    <div className="space-y-3 px-4 py-1">
      <p role="status" className="text-sm text-chat-foreground-faint">
        System: Offline checkout checks finished. Review the report before the next implementation
        step.
      </p>
      <p className="text-sm">
        The next step is ready for review. All existing owner decisions still apply.
      </p>
    </div>
  </div>
)
export const toolbarWide = defineFixture({
  width: 800,
  store: toolbarStore,
  render: () => toolbarRender()
})
export const toolbarNarrow = defineFixture({
  width: 390,
  store: toolbarStore,
  render: () => toolbarRender()
})

export const toolbarInactive = defineFixture({
  width: 800,
  store: toolbarStore,
  render: () => toolbarRender(false)
})
