import { defineFixture } from '../../../component-fixtures/component-fixture'
import { buildAntigravitySwarmSnapshot } from '../../../../../shared/agent-session/antigravity-swarm-snapshot'
import { summarizeAntigravityTranscript } from '../../../../../shared/agent-session/antigravity-swarm-transcript'
import { nativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatSwarmBoardPanel } from './NativeChatSwarmBoardPanel'
import { NativeChatSwarmStrip } from './NativeChatSwarmStrip'
import type { NativeChatSwarmBoardState } from './use-native-chat-swarm-board'

const backendTranscript = [
  JSON.stringify({
    step_index: 0,
    type: 'USER_INPUT',
    status: 'DONE',
    content: '<USER_REQUEST>\nImplement refresh token handler\n</USER_REQUEST>'
  }),
  JSON.stringify({
    step_index: 1,
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    tool_calls: [{ name: 'edit_file', args: { TargetFile: '/tmp/wt-backend/src/auth.ts' } }]
  })
].join('\n')

const snapshot = buildAntigravitySwarmSnapshot({
  swarmId: '11111111-1111-4111-8111-111111111111',
  etag: 'fixture-etag',
  membersJson: JSON.stringify({
    title: 'Auth refactor swarm',
    members: {
      coordinator: {
        conversation_id: '11111111-1111-4111-8111-111111111111',
        model: 'gemini-3.1-pro-high',
        role: 'coordinator',
        wake_mode: 'mentions',
        last_read_seq: 2,
        killed: false
      },
      monitor: {
        conversation_id: '44444444-4444-4444-8444-444444444444',
        model: 'gemini-3.1-flash-lite',
        role: 'monitor',
        wake_mode: 'mentions',
        last_read_seq: 3,
        killed: false
      },
      'backend-dev': {
        conversation_id: '22222222-2222-4222-8222-222222222222',
        model: 'claude-sonnet-4.6',
        role: 'worker',
        wake_mode: 'working',
        last_read_seq: 1,
        killed: false,
        worktree: '/tmp/wt-backend'
      },
      reviewer: {
        conversation_id: '33333333-3333-4333-8333-333333333333',
        model: 'gemini-3.1-flash',
        role: 'worker',
        wake_mode: 'mentions',
        last_read_seq: 3,
        killed: true
      }
    }
  }),
  boardJsonl: [
    JSON.stringify({
      seq: 1,
      agent: 'coordinator',
      text: 'Brief ready @backend-dev please implement token refresh',
      time: '2026-11-17 10:00:00'
    }),
    JSON.stringify({
      seq: 2,
      agent: 'backend-dev',
      text: '@coordinator Token handler updated, running unit tests now.',
      time: '2026-11-17 10:05:00',
      channel: 'api'
    }),
    JSON.stringify({
      seq: 3,
      agent: 'monitor',
      text: '@all All active workers progressing normally; zero stalls detected.',
      time: '2026-11-17 10:06:00'
    })
  ].join('\n'),
  planJson: JSON.stringify({
    goal: { title: 'Auth refactor', line: 'Refresh tokens cleanly' },
    steps: [
      { title: 'Audit flow', status: 'completed', owner: 'coordinator' },
      { title: 'Update refresh handler', status: 'in_progress', owner: 'backend-dev' },
      { title: 'Verify edge cases', status: 'pending', owner: 'reviewer' }
    ]
  }),
  transcriptByConversationId: new Map([
    [
      '22222222-2222-4222-8222-222222222222',
      summarizeAntigravityTranscript(backendTranscript, 1_000, 2_000)
    ]
  ]),
  now: 2_000
})

function boardState(overrides: Partial<NativeChatSwarmBoardState> = {}): NativeChatSwarmBoardState {
  return {
    canOpen: true,
    isOpen: true,
    open: () => {},
    close: () => {},
    toggle: () => {},
    snapshot,
    loading: false,
    error: null,
    refresh: () => {},
    selectedConversationId: null,
    selectMemberConversation: () => {},
    transcript: null,
    transcriptLoading: false,
    refreshTranscript: () => {},
    ...overrides
  }
}

export const stripCollapsed = defineFixture({
  width: 720,
  render: () =>
    snapshot ? (
      <div
        className="native-chat-appearance bg-chat-canvas py-3"
        style={nativeChatAppearanceStyle({})}
      >
        <NativeChatSwarmStrip snapshot={snapshot} isOpen={false} onToggle={() => {}} />
      </div>
    ) : (
      <div />
    )
})

const BOARD_STYLE: React.CSSProperties & Record<'--orca-pane-title-height', string> = {
  ...nativeChatAppearanceStyle({}),
  '--orca-pane-title-height': '36px'
}

export const boardOpen = defineFixture({
  width: 920,
  render: () =>
    snapshot ? (
      <div className="native-chat-appearance relative h-[540px] bg-chat-canvas" style={BOARD_STYLE}>
        <NativeChatSwarmBoardPanel
          board={boardState()}
          canMention
          onMention={() => {}}
          onCloseFocus={() => {}}
        />
        <div className="absolute inset-x-0 bottom-0 pb-3">
          <NativeChatSwarmStrip snapshot={snapshot} isOpen onToggle={() => {}} />
        </div>
      </div>
    ) : (
      <div />
    )
})
