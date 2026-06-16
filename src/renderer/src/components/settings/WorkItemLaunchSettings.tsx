import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import {
  NumberField,
  SettingsRow,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'

type WorkItemLaunchSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const MIN_INTERVAL_SECONDS = 20
const MAX_INTERVAL_SECONDS = 3600
const DEFAULT_INTERVAL_SECONDS = 60

/**
 * Two related "starting work from a work item" settings:
 *  1. Submit the linked prompt on launch (vs. leaving it as an editable draft).
 *  2. Auto-start GitLab issues assigned to a configured user (runs the normal
 *     start-work click automatically; off by default).
 */
export function WorkItemLaunchSettings({
  settings,
  updateSettings
}: WorkItemLaunchSettingsProps): React.JSX.Element {
  const submitOnLaunch = settings.submitWorkItemPromptOnLaunch !== false
  const autoStartEnabled = settings.gitlabAutoStartEnabled ?? false
  const assignee = settings.gitlabAutoStartAssignee ?? ''
  const intervalSeconds = settings.gitlabAutoStartIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS

  return (
    <>
      <SearchableSetting
        title={translate(
          'auto.components.settings.WorkItemLaunchSettings.submit_title',
          'Submit work-item prompt on launch'
        )}
        description={translate(
          'auto.components.settings.WorkItemLaunchSettings.submit_desc',
          'When starting work from an issue or PR, send the linked context as the agent’s first turn instead of leaving it pre-filled for you to submit.'
        )}
        keywords={[
          'work item',
          'issue',
          'pull request',
          'prompt',
          'submit',
          'draft',
          'prefill',
          'one shot',
          'oneshot',
          'launch',
          'agent'
        ]}
        className="space-y-3 py-2"
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.WorkItemLaunchSettings.submit_title',
            'Submit work-item prompt on launch'
          )}
          description={translate(
            'auto.components.settings.WorkItemLaunchSettings.submit_desc',
            'When starting work from an issue or PR, send the linked context as the agent’s first turn instead of leaving it pre-filled for you to submit.'
          )}
          checked={submitOnLaunch}
          onChange={() => updateSettings({ submitWorkItemPromptOnLaunch: !submitOnLaunch })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.WorkItemLaunchSettings.autostart_title',
          'Auto-start GitLab issues by assignee'
        )}
        description={translate(
          'auto.components.settings.WorkItemLaunchSettings.autostart_desc',
          'Watch your GitLab repos and automatically start work on open issues assigned to a chosen user — the same as selecting the issue and starting it yourself.'
        )}
        keywords={[
          'gitlab',
          'assignee',
          'auto start',
          'autostart',
          'issue',
          'work item',
          'automation',
          'bot',
          'agent'
        ]}
        className="space-y-3 py-2"
      >
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_title',
            'Auto-start GitLab issues by assignee'
          )}
          description={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_desc',
            'Watch your GitLab repos and automatically start work on open issues assigned to a chosen user — the same as selecting the issue and starting it yourself.'
          )}
        />
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_enable',
            'Enable auto-start'
          )}
          description={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_enable_desc',
            'Requires an assignee handle below. Each matching issue is started once; the prompt is always submitted so it runs unattended.'
          )}
          checked={autoStartEnabled}
          onChange={() => updateSettings({ gitlabAutoStartEnabled: !autoStartEnabled })}
        />
        <SettingsRow
          label={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_assignee',
            'Assignee handle'
          )}
          description={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_assignee_desc',
            'GitLab username (without @) whose newly-assigned open issues are auto-started.'
          )}
          control={
            <Input
              value={assignee}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder={translate(
                'auto.components.settings.WorkItemLaunchSettings.autostart_assignee_ph',
                'orca'
              )}
              onChange={(event) => updateSettings({ gitlabAutoStartAssignee: event.target.value })}
              className="w-48"
            />
          }
        />
        <NumberField
          label={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_interval',
            'Check interval'
          )}
          description={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_interval_desc',
            'How often Orca polls GitLab for newly-assigned issues.'
          )}
          value={intervalSeconds}
          defaultValue={DEFAULT_INTERVAL_SECONDS}
          min={MIN_INTERVAL_SECONDS}
          max={MAX_INTERVAL_SECONDS}
          step={10}
          suffix={translate(
            'auto.components.settings.WorkItemLaunchSettings.autostart_interval_suffix',
            'seconds'
          )}
          onChange={(next) => updateSettings({ gitlabAutoStartIntervalSeconds: next })}
        />
      </SearchableSetting>
    </>
  )
}
