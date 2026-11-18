import { AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { loadHostStructuredAgents } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
import { refreshLocalRuntimeCapabilities } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { useEffect, useRef } from 'react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FixtureCodeBackdrop } from '../../../component-fixtures/FixtureCodeBackdrop'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SortableTabContextMenu } from './SortableTabContextMenu'

const noop = (): void => {}

function MenuFixture({ nativeChat }: { nativeChat?: { sessionId: string; agent: 'codex' } }) {
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    trigger.current?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, clientX: 16, clientY: 8 })
    )
  }, [])
  return (
    <div className="relative h-[420px] overflow-hidden bg-background">
      <FixtureCodeBackdrop />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button ref={trigger}>Tab</button>
        </ContextMenuTrigger>
        <SortableTabContextMenu
          open
          nativeChat={nativeChat}
          canSplitTerminal={!nativeChat}
          tab={{ id: 'tab-1', worktreeId: 'wt-1', color: null }}
          unifiedTabId="tab-1"
          groupId="group-1"
          isActive
          tabCount={3}
          hasTabsToRight
          hasTabsToLeft={false}
          isPinned={false}
          onActivate={noop}
          onClose={noop}
          onCloseOthers={noop}
          onCloseToRight={noop}
          onCloseToLeft={noop}
          onRenameOpen={noop}
          onSetTabColor={noop}
          onTogglePin={noop}
        />
      </ContextMenu>
    </div>
  )
}

export const open = defineFixture({ width: 360, render: () => <MenuFixture /> })

export const currentSideChat = defineFixture({
  width: 560,
  store: {
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          entityId: 'source-session',
          worktreeId: 'wt-1',
          groupId: 'group-1',
          contentType: 'agent-session',
          executionHostId: 'local',
          agentSessionAgent: 'codex',
          label: 'Codex Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  },
  setup: () => {
    const capabilities = [
      AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY,
      STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
    ]
    const call = window.api.runtime.call
    window.api.runtime.getStatus = async () => ({
      runtimeId: 'fixture-runtime',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 1,
      liveLeafCount: 1,
      capabilities
    })
    window.api.runtime.call = async (request) =>
      request.method === 'agentSession.agents'
        ? {
            id: 'fixture-agents',
            _meta: { runtimeId: 'fixture-runtime' },
            ok: true,
            result: { agents: [{ agent: 'codex', capabilities: { currentFork: true } }] }
          }
        : call(request)
    void refreshLocalRuntimeCapabilities()
    void loadHostStructuredAgents('local', capabilities, null)
  },
  render: () => <MenuFixture nativeChat={{ sessionId: 'source-session', agent: 'codex' }} />,
  interact: async () => {
    await refreshLocalRuntimeCapabilities()
    await loadHostStructuredAgents(
      'local',
      [
        AGENT_SESSION_CREATE_CURRENT_FORK_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ],
      null
    )
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (element) => element.textContent === 'New side chat'
    )
    if (!item) {
      throw new Error('Side chat menu did not render')
    }
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
})
