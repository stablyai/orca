import { DndContext } from '@dnd-kit/core'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import SortableTab from './SortableTab'
import { TabStripTooltipProvider } from '../strip/TabStripTooltipProvider'
import { i18n } from '@/i18n/i18n'
import { NativeChatForkedFromContext } from '../../native-chat/messages/actions/native-chat-fork-context'
import { NativeChatNoticeRow } from '../../native-chat/messages/notices/NativeChatNoticeRow'

const noop = (): void => {}

function ChatTab({
  id,
  title,
  forked,
  sideChat = false,
  width,
  active = false
}: {
  id: string
  title: string
  forked: boolean
  sideChat?: boolean
  width?: number
  active?: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-8" style={width ? { width } : undefined}>
      <SortableTab
        tab={{ id, worktreeId: 'fixture', title, customTitle: null, color: null }}
        agent={sideChat ? 'codex' : 'claude'}
        sideChat={sideChat}
        unifiedTabId={id}
        groupId="fixture-group"
        tabCount={3}
        hasTabsToRight
        hasTabsToLeft={false}
        isActive={active}
        isPinned={false}
        isExpanded={false}
        onActivate={noop}
        onClose={noop}
        onCloseOthers={noop}
        onCloseToRight={noop}
        onCloseToLeft={noop}
        onSetCustomTitle={noop}
        onSetTabColor={noop}
        onTogglePin={noop}
        onToggleExpand={noop}
        dragData={{
          kind: 'tab',
          worktreeId: 'fixture',
          groupId: 'fixture-group',
          unifiedTabId: id,
          visibleTabId: id,
          tabType: 'agent-session',
          label: title,
          color: null
        }}
        canSplitTerminal={false}
        fork={
          forked
            ? {
                describeSource: () => 'Fork of Annotate capabilities',
                markedTitle: `Fork · ${title}`
              }
            : undefined
        }
      />
    </div>
  )
}

function Strip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <DndContext>
      <TabStripTooltipProvider>
        <div className="flex h-8 items-stretch bg-card">{children}</div>
      </TabStripTooltipProvider>
    </DndContext>
  )
}

export const defaultWidth = defineFixture({
  width: 1240,
  render: () => (
    <Strip>
      <ChatTab id="original" title="Annotate capabilities" forked={false} />
      <ChatTab id="fork" title="Annotate capabilities" forked active />
      <ChatTab id="fork-2" title="Plan the migration" forked />
      <ChatTab id="unnamed-fork" title="Claude Chat" forked />
    </Strip>
  )
})

export const narrow = defineFixture({
  width: 560,
  render: () => (
    <Strip>
      <ChatTab id="original" title="Annotate capabilities" forked={false} width={150} />
      <ChatTab id="fork" title="Annotate capabilities" forked active width={150} />
      <ChatTab id="fork-170" title="Annotate capabilities" forked width={170} />
    </Strip>
  )
})

export const hoverCard = defineFixture({
  width: 420,
  render: () => (
    <div className="h-40">
      <Strip>
        <ChatTab id="fork" title="Annotate capabilities" forked active />
      </Strip>
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLElement>('[data-testid="sortable-tab"]')?.focus()
  }
})

function localized(language: string) {
  return defineFixture({
    width: 760,
    render: () => (
      <div className="space-y-3">
        <Strip>
          <ChatTab id="fork" title="Annotate capabilities" forked active />
          <ChatTab id="fork-narrow" title="Annotate capabilities" forked width={170} />
        </Strip>
        <div className="native-chat-appearance bg-background px-4">
          <NativeChatForkedFromContext.Provider value={noop}>
            <NativeChatNoticeRow
              block={{
                type: 'text',
                text: 'Forked from Annotate capabilities',
                presentation: 'forked-from',
                forkedFrom: { sessionId: 'source', sourceForked: true }
              }}
            />
          </NativeChatForkedFromContext.Provider>
        </div>
      </div>
    ),
    // Fixture pages share one i18n instance; run these shots last, then restart the server.
    interact: async () => {
      await i18n.changeLanguage(language)
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
}

export const german = localized('de')
export const japanese = localized('ja')
export const russianNarrow = defineFixture({
  ...localized('ru'),
  width: 460,
  render: () => (
    <Strip>
      <ChatTab id="fork-200" title="Annotate capabilities" forked active width={200} />
      <ChatTab id="fork-170" title="Annotate capabilities" forked width={170} />
    </Strip>
  )
})

export const sideChats = defineFixture({
  width: 900,
  render: () => (
    <Strip>
      <ChatTab id="main-chat" title="Main conversation" forked={false} width={280} />
      <ChatTab
        id="side-1"
        title="Review the deployment plan"
        forked={false}
        sideChat
        active
        width={300}
      />
      <ChatTab id="side-2" title="Investigate the failure" forked={false} sideChat width={300} />
    </Strip>
  )
})

export const crowdedSideChats = defineFixture({
  width: 480,
  render: () => (
    <Strip>
      <ChatTab id="side-1" title="Review deployment" forked={false} sideChat active width={120} />
      <ChatTab id="side-2" title="Investigate failure" forked={false} sideChat width={120} />
      <ChatTab id="side-3" title="Check tests" forked={false} sideChat width={120} />
      <ChatTab id="side-4" title="Compare approaches" forked={false} sideChat width={120} />
    </Strip>
  )
})

export const sideChatWidths = defineFixture({
  width: 550,
  render: () => (
    <Strip>
      <ChatTab id="parent" title="Plan a release" forked={false} width={150} />
      <ChatTab id="side-narrow" title="Review the API" forked={false} sideChat width={150} active />
      <ChatTab id="side-wide" title="Compare approaches" forked={false} sideChat width={220} />
    </Strip>
  )
})
