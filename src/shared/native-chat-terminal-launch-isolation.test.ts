import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG, isTuiAgent } from './tui-agent-config'
import { AGENT_CHAT_PERMISSION_MODES } from './agent-chat-permission-mode'
import type { GlobalSettings } from './global-settings-types'
import { applyAgentPermissionMode } from './tui-agent-permissions'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'

function terminalLaunches(settings: Partial<GlobalSettings>) {
  return Object.fromEntries(
    Object.keys(TUI_AGENT_CONFIG)
      .filter(isTuiAgent)
      .map((id) => [
        id,
        {
          args: resolveTuiAgentLaunchArgs(id, settings.agentDefaultArgs),
          env: resolveTuiAgentLaunchEnv(id, settings.agentDefaultEnv)
        }
      ])
  )
}

describe('terminal launch arguments remain on the main baseline', () => {
  it.each(['yolo', 'manual'] as const)(
    'preserves every agent under %s regardless of chat permissions',
    (mode) => {
      const terminal = applyAgentPermissionMode({ mode })
      const baseline = terminalLaunches(terminal)
      expect(baseline).toMatchSnapshot()
      for (const nativeChatPermissionMode of AGENT_CHAT_PERMISSION_MODES) {
        expect(terminalLaunches({ ...terminal, nativeChatPermissionMode })).toEqual(baseline)
      }
    }
  )
})
