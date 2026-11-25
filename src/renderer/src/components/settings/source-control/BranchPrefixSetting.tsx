import { useEffect, useId, useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { BranchPrefixFeedback } from './BranchPrefixFeedback'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'
import { useTranslate } from '@/i18n/use-translate'

/** The host that creates a workspace names its branch, so the prefix is read and written on that host. */
export function BranchPrefixSetting({
  hostScope,
  settings,
  updateSettings,
  displayedGitUsername
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  /** This computer's Git username; a server resolves its own at create time. */
  displayedGitUsername: string
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const hostArgs = {
    owner: hostScope.target,
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  }
  const strategy = useHostSetting({ ...hostArgs, settingKey: 'branchPrefix' })
  const custom = useHostSetting({ ...hostArgs, settingKey: 'branchPrefixCustom' })
  const branchPrefix = strategy.setting.state === 'ready' ? strategy.setting.value : null
  const savedCustom = custom.setting.state === 'ready' ? custom.setting.value : ''
  const ready =
    hostScope.available && strategy.setting.state === 'ready' && custom.setting.state === 'ready'
  const unsupported =
    strategy.setting.state === 'unsupported' || custom.setting.state === 'unsupported'
  const onServer = hostScope.target.kind === 'environment'

  // Local drafts preserve caret/fast typing through async writes; adopt external reloads but ignore delayed echoes of our own edits.
  const [customPrefixDraft, setCustomPrefixDraft] = useState(savedCustom)
  const lastCommittedPrefixRef = useRef(savedCustom)
  useEffect(() => {
    if (savedCustom !== lastCommittedPrefixRef.current) {
      lastCommittedPrefixRef.current = savedCustom
      setCustomPrefixDraft(savedCustom)
    }
  }, [savedCustom])
  const usesGitUsername = branchPrefix === 'git-username'
  const inputValue = usesGitUsername ? (onServer ? '' : displayedGitUsername) : customPrefixDraft
  const showInput = branchPrefix !== null && branchPrefix !== 'none'

  return (
    <SearchableSetting
      title={t('auto.components.settings.GitPane.7826f35f63', 'Branch prefix')}
      description={t(
        'auto.components.settings.GitPane.1ffaadf0a0',
        'Prefix added to branch names when creating worktrees.'
      )}
      keywords={['branch naming', 'git username', 'custom']}
      className="space-y-3 py-3"
    >
      <div className="space-y-0.5">
        <Label htmlFor={inputId}>
          {t('auto.components.settings.GitPane.7826f35f63', 'Branch prefix')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {unsupported
            ? getHostSettingUnsupportedNote(hostLabel, t)
            : t(
                'auto.components.settings.GitPane.1ec5c91e1d',
                'Choose whether branch names use your Git username, a custom prefix, or no prefix.'
              )}
        </p>
      </div>
      <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
        {(['git-username', 'custom', 'none'] as const).map((option) => (
          <button
            key={option}
            disabled={!ready}
            onClick={() => void strategy.update(option)}
            className={`rounded-sm px-3 py-1 text-sm transition-colors disabled:pointer-events-none disabled:opacity-50 ${
              branchPrefix === option
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {option === 'git-username'
              ? t('auto.components.settings.GitPane.d12c81a103', 'Git username')
              : option === 'custom'
                ? t('auto.components.settings.GitPane.1f32ba27a6', 'Custom')
                : t('auto.components.settings.GitPane.3d172725cc', 'None')}
          </button>
        ))}
      </div>
      {showInput && (
        <Input
          id={inputId}
          value={inputValue}
          onChange={(e) => {
            const next = e.target.value
            lastCommittedPrefixRef.current = next
            setCustomPrefixDraft(next)
            void custom.update(next)
          }}
          placeholder={
            usesGitUsername
              ? onServer
                ? t(
                    'components.settings.git.branchPrefixHostGitUsername',
                    'Git username on {{host}}',
                    { host: hostLabel }
                  )
                : t('auto.components.settings.GitPane.aefa1ecb59', 'No git username configured')
              : t('auto.components.settings.GitPane.b559bf9899', 'e.g. feature')
          }
          className="max-w-xs"
          readOnly={usesGitUsername || !ready}
        />
      )}
      {showInput && <BranchPrefixFeedback rawPrefix={inputValue} />}
    </SearchableSetting>
  )
}
