import { defineFixture } from '../../component-fixtures/component-fixture'
import { SideChatTabBadge } from './SideChatTabBadge'
import SortableTab, { type SortableTabProps } from './SortableTab'

const noop = (): void => {}
const props: SortableTabProps = {
  tab: {
    id: 'side',
    worktreeId: 'workspace',
    title: 'Review the latest results',
    customTitle: null,
    color: null
  },
  agent: 'codex',
  nativeChat: { sessionId: 'codex_side', agent: 'codex', sideChat: true },
  unifiedTabId: 'side',
  groupId: 'group',
  tabCount: 4,
  hasTabsToLeft: false,
  hasTabsToRight: true,
  isActive: true,
  isPinned: false,
  isExpanded: false,
  onActivate: noop,
  onClose: noop,
  onCloseOthers: noop,
  onCloseToRight: noop,
  onCloseToLeft: noop,
  onSetCustomTitle: noop,
  onSetTabColor: noop,
  onTogglePin: noop,
  onToggleExpand: noop,
  dragData: {
    kind: 'tab',
    worktreeId: 'workspace',
    groupId: 'group',
    unifiedTabId: 'side',
    visibleTabId: 'side',
    tabType: 'agent-session',
    label: 'Review the latest results',
    sideChat: true
  }
}

const now = Date.now()
export const crowded = defineFixture({
  store: {
    agentStatusByPaneKey: {
      'side:11111111-1111-4111-8111-111111111111': {
        paneKey: 'side:11111111-1111-4111-8111-111111111111',
        state: 'working',
        agentType: 'codex',
        prompt: '',
        updatedAt: now,
        stateStartedAt: now,
        stateHistory: []
      }
    },
    ptyIdsByTabId: { side: ['fixture-pty'] }
  },
  width: 420,
  interact: (frame) => {
    for (const tab of frame.querySelectorAll<HTMLElement>('[data-testid="sortable-tab"]')) {
      const title = tab.querySelector<HTMLElement>('.truncate')
      const close = tab.querySelector<HTMLElement>('[data-tab-close-button]')
      if (
        !title ||
        title.clientWidth < 12 ||
        (close && close.getBoundingClientRect().right > tab.getBoundingClientRect().right + 1)
      ) {
        throw new Error(
          `Side chat title/close control overflow at ${tab.clientWidth}px (title ${title?.clientWidth}px)`
        )
      }
    }
  },
  render: () => (
    <div className="space-y-3 bg-card p-3 text-foreground">
      {[72, 100, 180].map((width) => (
        <div key={width} className="flex h-9" style={{ width }} data-side-chat-width={width}>
          <SortableTab {...props} />
        </div>
      ))}
    </div>
  )
})

export const grouped = defineFixture({
  width: 980,
  render: () => (
    <div className="flex h-96 bg-background text-foreground text-sm">
      <div className="flex min-w-0 flex-1 flex-col border border-border">
        <div className="flex h-9 shrink-0 bg-card">
          <SortableTab
            {...props}
            tab={{ ...props.tab, title: 'Main task' }}
            nativeChat={{ sessionId: 'codex_main', agent: 'codex' }}
          />
        </div>
        <div className="flex-1 p-6">Main conversation</div>
      </div>
      <div
        className="group/side-chat-pane flex min-w-0 flex-1 flex-col border border-border"
        data-side-chat-only="true"
      >
        <div className="flex h-9 shrink-0 bg-card">
          <span className="flex shrink-0 items-center border-r border-border px-1.5">
            <SideChatTabBadge className="mr-0" />
          </span>
          {['Review results', 'Compare options', 'Explain the logs'].map((title, index) => (
            <SortableTab
              {...props}
              key={title}
              tab={{ ...props.tab, id: `side-${index}`, title }}
              isActive={index === 0}
            />
          ))}
        </div>
        <div className="flex-1 p-6">Selected side conversation</div>
      </div>
    </div>
  )
})
