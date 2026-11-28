import { defineFixture } from '@/component-fixtures/component-fixture'
import { fixtureCos } from '@/component-fixtures/fixture-bot-panel'
import { stubBots } from '@/component-fixtures/fixture-bots'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const bot = {
  ...fixtureCos,
  id: 'build-bot',
  name: 'Build Bot',
  folder: 'build',
  folderWorkspaceId: 'build-home',
  chatSessionId: 'build-chat'
}

function BotHomeLink(): React.JSX.Element {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  return (
    <div className="space-y-4 p-5">
      <NativeChatMarkdown
        variant="document"
        allowBotHomeLinks
        content="You can find the build report in [Build Bot’s Home](orca://bot/build-bot)."
      />
      <div className="border-t border-border pt-3 text-sm text-muted-foreground">
        {activeWorktreeId === 'folder:build-home'
          ? 'Build Bot Home opened'
          : 'Build Bot Home closed'}
      </div>
    </div>
  )
}

export const click = defineFixture({
  width: 450,
  store: {
    activeWorktreeId: null,
    folderWorkspaces: [
      makeFolderWorkspace({ id: 'build-home', name: 'Build Bot', folderPath: '/example/build' })
    ],
    fetchFolderWorkspaces: async () => {}
  },
  setup: () =>
    stubBots([bot], undefined, {
      results: {
        'bots.chat.open': { sessionId: 'build-chat' },
        'session.tabs.activate': { activated: true }
      }
    }),
  render: () => <BotHomeLink />,
  interact: async (frame) => {
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.activeWorktreeId === 'folder:build-home') {
          clearTimeout(timeout)
          unsubscribe()
          resolve()
        }
      })
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error('Clicking the Bot Home link did not activate its workspace'))
      }, 1000)
      frame.querySelector<HTMLElement>('.native-chat-markdown :is(a, button)')?.click()
    })
  }
})
