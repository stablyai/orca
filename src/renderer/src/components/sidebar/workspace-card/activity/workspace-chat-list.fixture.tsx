import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { WorkspaceChatList } from './workspace-chat-list'
import { useState, useSyncExternalStore } from 'react'
import { WorkspaceChatCatalog } from '@/lib/agent-session/history/workspace-chats'

function ArchiveDemo() {
  const [catalog] = useState(() => {
    const next = new WorkspaceChatCatalog(null)
    next.remember({
      workspaceId: 'fixture-workspace',
      executionHostId: 'local',
      sessionId: 'archive-one',
      agent: 'codex',
      title: 'Finished navigation work'
    })
    next.remember({
      workspaceId: 'fixture-workspace',
      executionHostId: 'local',
      sessionId: 'archive-two',
      agent: 'claude',
      title: 'Keep reviewing mobile layout'
    })
    return next
  })
  const chats = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot, catalog.getSnapshot)
  return (
    <WorkspaceChatList
      chats={chats}
      onOpen={async () => {}}
      onArchive={(chat) => catalog.archive(chat)}
    />
  )
}

export const saved = defineFixture({
  width: 300,
  render: () => (
    <WorkspaceChatList
      chats={[
        {
          workspaceId: 'fixture-workspace',
          executionHostId: 'local',
          sessionId: 'one',
          agent: 'codex',
          title: 'Build the website navigation'
        },
        {
          workspaceId: 'fixture-workspace',
          executionHostId: 'local',
          sessionId: 'two',
          agent: 'claude',
          title: 'Review responsive layout on mobile'
        }
      ]}
      onOpen={async () => {}}
      onArchive={() => {}}
    />
  )
})

export const beforeArchive = defineFixture({
  width: 300,
  render: () => <ArchiveDemo />
})

export const archived = defineFixture({
  width: 300,
  render: () => <ArchiveDemo />,
  interact: async (frame) => {
    const archive = frame.querySelector<HTMLButtonElement>(
      '[aria-label="Archive chat: Finished navigation work"]'
    )
    if (!archive) {
      throw new Error('Archive control missing')
    }
    archive.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (
      frame.textContent?.includes('Finished navigation work') ||
      !frame.textContent?.includes('Keep reviewing mobile layout')
    ) {
      throw new Error('Archive must remove only the selected saved chat')
    }
  }
})
