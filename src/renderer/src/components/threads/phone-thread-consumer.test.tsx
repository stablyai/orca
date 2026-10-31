import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { useState, type ReactNode } from 'react'
import { MobileSessionTab } from '../../../../../mobile/src/session/MobileSessionTab'
import { getMobileSessionTabTitle } from '../../../../../mobile/src/session/mobile-terminal-tab-agent'
import { mountFixture } from '../../../../../mobile/src/test-support/rpc-recording/recorder-fixture-shape'
import { agentSessionRecordFixture } from '../../../../main/native-chat/agent-session-record-test-fixture'
import { projectSessionTabAgentStatus } from '../../../../main/runtime/rpc/methods/session-tab-agent-status-projection'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { structuredAgentSessionHostTabId } from '../../../../shared/structured-agent-session-host-tab-id'

vi.mock('react-native', () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityState,
    onPress
  }: {
    children: ReactNode
    accessibilityLabel: string
    accessibilityState: { selected: boolean }
    onPress: () => void
  }) => (
    <button
      role="tab"
      aria-label={accessibilityLabel}
      aria-selected={accessibilityState.selected}
      onClick={onPress}
    >
      {children}
    </button>
  )
}))
vi.mock('lucide-react-native', () => ({
  File: () => null,
  FileText: () => null,
  Globe: () => null,
  SquareTerminal: () => null
}))
vi.mock('../../../../../mobile/src/components/detail-card-host', () => ({
  DetailCardFocusBoundary: () => null
}))
vi.mock('../../../../../mobile/src/components/use-anchored-detail-card', () => ({
  useDetailCardSource: () => {}
}))
vi.mock('../../../../../mobile/src/components/MobileAgentIcon', () => ({
  MobileAgentIcon: () => null
}))
vi.mock('../../../../../mobile/src/components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('../../../../../mobile/src/session/mobile-session-styles', () => ({ styles: {} }))
vi.mock('../../../../../mobile/src/theme/mobile-theme', () => ({ colors: {} }))
beforeEach(() => {
  const window = new Window()
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('navigator', window.navigator)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps a classified host snapshot visible on the phone with its own title and selected conversation', () => {
  const records = [
    agentSessionRecordFixture({
      sessionId: 'ordinary',
      provider: 'codex',
      conversationName: 'Ordinary chat'
    }),
    agentSessionRecordFixture({
      sessionId: 'chosen',
      provider: 'codex',
      surface: 'thread',
      conversationName: 'Chosen thread'
    })
  ]
  const raw = {
    worktree: 'repo::/main',
    publicationEpoch: 'host',
    snapshotVersion: 1,
    activeTabId: structuredAgentSessionHostTabId('chosen'),
    activeTabType: 'agent-session' as const,
    tabs: records.map((record) => ({
      type: 'agent-session' as const,
      id: structuredAgentSessionHostTabId(record.sessionId),
      sessionId: record.sessionId,
      agent: record.provider,
      title: record.conversationName ?? '',
      isActive: record.sessionId === 'chosen'
    }))
  }
  const snapshot = projectSessionTabAgentStatus(raw, 'mobile', [
    STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
  ])
  expect(snapshot.tabs).toBe(raw.tabs)
  function PhoneTabs() {
    const [active, setActive] = useState(snapshot.activeTabId)
    return snapshot.tabs.map((tab, index) => (
      <MobileSessionTab
        key={tab.id}
        tab={tab}
        first={index === 0}
        active={tab.id === active}
        title={getMobileSessionTabTitle(tab)}
        agentId={tab.agent}
        details={mountFixture<Parameters<typeof MobileSessionTab>[0]['details']>({
          activeKey: null,
          requestedKey: null,
          boundaryRefs: { current: [] },
          refreshSource: () => {}
        })}
        barRef={{ current: null }}
        onLayout={() => {}}
        onPress={() => setActive(tab.id)}
        onLongPress={() => {}}
      />
    ))
  }
  const screen = render(<PhoneTabs />)
  expect(screen.getByRole('tab', { name: 'Chosen thread' }).getAttribute('aria-selected')).toBe(
    'true'
  )
  fireEvent.click(screen.getByRole('tab', { name: 'Ordinary chat' }))
  expect(screen.getByRole('tab', { name: 'Ordinary chat' }).getAttribute('aria-selected')).toBe(
    'true'
  )
  expect(screen.getByRole('tab', { name: 'Chosen thread' }).getAttribute('aria-selected')).toBe(
    'false'
  )
})
