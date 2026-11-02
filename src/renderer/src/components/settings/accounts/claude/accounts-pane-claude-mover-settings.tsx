import { ClaudeAuthProxySetting } from './claude-auth-proxy-setting'
import { ClaudeRecentMoves } from './claude-recent-moves'
import { ClaudeRunningSessionSwitchSetting } from './claude-running-session-switch-setting'
import { ClaudeSessionMoverSetting } from './claude-session-mover-setting'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

/** Session-switch and session-mover controls under the Claude account list. */
export function renderClaudeMoverSettings(model: AccountsPaneSectionModel): React.JSX.Element {
  const { claudeAccounts, isRemoteAccountScope, settings, updateSettings } = model
  return (
    <>
      {isRemoteAccountScope ? null : (
        <>
          <ClaudeRunningSessionSwitchSetting settings={settings} updateSettings={updateSettings} />
          <ClaudeSessionMoverSetting settings={settings} updateSettings={updateSettings} />
          <ClaudeAuthProxySetting settings={settings} updateSettings={updateSettings} />
        </>
      )}
      <ClaudeRecentMoves moves={claudeAccounts.sessionMoves} />
    </>
  )
}
