import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Bot } from '../../../../shared/bot-types'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { OpenAgentSettingsMenuItem } from '../agent/launch-menu/OpenAgentSettingsMenuItem'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import { BotNewChatMenuItems } from './BotNewChatMenuItems'

const bot: Bot = {
  id: 'release-helper',
  name: 'Release helper',
  hostId: 'local',
  folder: 'release-helper',
  folderWorkspaceId: 'fw-release-helper',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'release-helper-chat',
  createdAt: 0,
  updatedAt: 0
}

// The user has three agents on this host, one whose chat this host can't run, and has turned one
// off in Agent settings (no row); every other agent only offers to install itself first.
const SETUP_ONLY: TuiAgent[] = [
  'grok',
  'omp',
  'pi',
  'antigravity',
  'hermes',
  'copilot',
  'opencode2',
  'kimi',
  'kiro',
  'aug',
  'goose',
  'kilo',
  'mimo-code',
  'droid',
  'qwen-code',
  'cline',
  'devin',
  'codebuddy'
]
const rows: NewTabAgentMenuRow[] = [
  { kind: 'chat', agent: 'claude' },
  { kind: 'chat', agent: 'codex' },
  ...SETUP_ONLY.map((agent) => ({ kind: 'chat' as const, agent, setup: true as const })),
  { kind: 'chat-unavailable', agent: 'cursor', reason: 'not-on-host' },
  { kind: 'cli', agent: 'opencode', chat: true }
]
const model: NewTabAgentMenuModel = {
  state: 'settled',
  rows,
  detection: {
    detectedIds: ['claude', 'codex', 'cursor', 'opencode', 'gemini'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    needsServerUpdate: false,
    refresh: async () => []
  }
}

function menuCase(width: number) {
  return defineFixture({
    width: width + 40,
    render: () => (
      <ConfirmationDialogProvider>
        <div className="h-[1100px] bg-background p-3">
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New</DropdownMenuTrigger>
            <DropdownMenuContent align="start" style={{ width }}>
              <BotNewChatMenuItems bot={bot} model={model} />
              <DropdownMenuSeparator />
              <OpenAgentSettingsMenuItem variant="create" />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

export const narrow = menuCase(260)
export const wide = menuCase(420)
