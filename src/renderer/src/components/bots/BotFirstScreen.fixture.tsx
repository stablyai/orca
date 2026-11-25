import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import type { Bot } from '../../../../shared/bot-types'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { NativeChatVisualOwnerContext } from '../native-chat/media/visuals/native-chat-visual-owner'
import { BotFirstScreen } from './BotFirstScreen'

const builder: Bot = {
  id: 'bot-builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'fw-builder',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const CLI = '"${ORCA_CLI_COMMAND:-orca}"'

const bash = (callId: string, command: string): NativeChatBlock => ({
  type: 'tool-call',
  name: 'Bash',
  callId,
  input: { command }
})

const result = (callId: string, output: string): NativeChatBlock => ({
  type: 'tool-result',
  callId,
  output,
  isError: false
})

const PS = [
  'webhooks · orca · host=local · active 25m ago',
  '--worktree id:r1::/src/webhooks',
  'agent claude idle, 25m ago (--terminal term_a)',
  '',
  'automations-improve · orca · host=local · active 4m ago',
  '--worktree id:r1::/src/automations-improve',
  'agent codex working, 4m ago (--terminal term_b)',
  '',
  'mobile-ota · orca · host=local · active 3d ago',
  '--worktree id:r1::/src/mobile-ota',
  'no agent open',
  '',
  'Host scope: local'
].join('\n')

function turn(psDone: boolean): NativeChatMessage[] {
  return [
    {
      id: 'first-turn',
      role: 'assistant',
      source: 'transcript',
      timestamp: 1,
      blocks: [
        bash('1', `${CLI} repo list`),
        result('1', 'r1  orca  /src/orca\nr2  api  /src/api'),
        bash('2', "gh search prs --author=@me --state=open --limit 100 --jq '.[]'"),
        result('2', 'stablyai/orca#388 bots: take over workspaces\nstablyai/orca#30410 Retry'),
        bash('3', `${CLI} linear list-issues --assignee me --state open --limit 50`),
        result('3', 'ENG-1  Todo  me  Bot onboarding'),
        bash('4', `${CLI} worktree ps --since 7d`),
        ...(psDone ? [result('4', PS)] : []),
        ...(psDone
          ? [bash('5', 'claude mcp list'), result('5', 'sentry: npx sentry-mcp - ✓ Connected')]
          : [])
      ]
    }
  ]
}

const owner = {
  target: { kind: 'local' as const },
  sessionId: 'session-builder',
  worktreeId: folderWorkspaceKey(builder.folderWorkspaceId)
}

function screen(psDone: boolean): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <div className="native-chat-appearance relative h-[520px] bg-background">
        <BotFirstScreen
          firstScreen={{ phase: 'starting', turn: turn(psDone), refused: null }}
          isVisible={false}
        />
      </div>
    </NativeChatVisualOwnerContext.Provider>
  )
}

// A new bot's first turn, reading its owner's workspaces.
export const readingWorkspaces = defineFixture({
  width: 720,
  setup: () => stubBots([builder]),
  render: () => screen(false)
})

// Every area read: the workspaces row counts those with an agent open.
export const allRead = defineFixture({
  width: 720,
  setup: () => stubBots([builder]),
  render: () => screen(true)
})
