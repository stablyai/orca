import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { isNativeChatShellEnvironmentName } from '../../../../../shared/native-chat/settings/native-chat-shell-environment'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Label } from '../../ui/label'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { getChatBehaviorEntriesByKey } from './chat-behavior-search'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../host-scope/use-host-setting'

type NativeChatShellEnvironmentSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** The host whose chat agents inherit its login-shell environment. */
  hostScope: SettingsHostScope
}

const NAME_INPUT_ID = 'settings-native-chat-shell-environment-name'

function ShellEnvironmentNamesField({
  savedNames,
  onChange
}: {
  savedNames: readonly string[]
  onChange: (names: string[]) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const name = draft.trim()
  const canAdd = isNativeChatShellEnvironmentName(name)

  const add = (): void => {
    if (!canAdd) {
      return
    }
    if (!savedNames.includes(name)) {
      onChange([...savedNames, name])
    }
    setDraft('')
    inputRef.current?.focus()
  }

  const remove = (savedName: string): void => {
    onChange(savedNames.filter((entry) => entry !== savedName))
    // The chip's own button unmounts with it, so keyboard focus would otherwise drop to the page.
    inputRef.current?.focus()
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={NAME_INPUT_ID}>
        {t(
          'auto.components.settings.ExperimentalPane.nativeChat.shellEnvNamesLabel',
          'Variables to pass from your shell'
        )}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          id={NAME_INPUT_ID}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) {
              return
            }
            event.preventDefault()
            add()
          }}
          placeholder={t(
            'auto.components.settings.ExperimentalPane.nativeChat.shellEnvNamePlaceholder',
            'Variable name'
          )}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="h-8"
        />
        <Button type="button" variant="outline" size="sm" disabled={!canAdd} onClick={add}>
          <Plus className="size-3.5" />
          {t('auto.components.settings.ExperimentalPane.nativeChat.shellEnvNameAdd', 'Add')}
        </Button>
      </div>
      {savedNames.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.ExperimentalPane.nativeChat.shellEnvNamesEmpty',
            'No variables added yet.'
          )}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {savedNames.map((savedName) => (
            <li
              key={savedName}
              title={savedName}
              className="inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-md border border-border/50 bg-muted/35 py-1 pl-2 pr-1 font-mono text-[11px] text-foreground/80"
            >
              <span className="truncate">{savedName}</span>
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={() => remove(savedName)}
                aria-label={t(
                  'auto.components.settings.ExperimentalPane.nativeChat.shellEnvNameRemove',
                  'Remove {{value0}}',
                  { value0: savedName }
                )}
                className="size-4 shrink-0"
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.settings.ExperimentalPane.nativeChat.shellEnvNamesAlwaysPassed',
          'PATH, locale, and SSH_AUTH_SOCK are always passed. Applies the next time a chat starts or resumes.'
        )}
      </p>
    </div>
  )
}

export function NativeChatShellEnvironmentSetting({
  settings,
  updateSettings,
  hostScope
}: NativeChatShellEnvironmentSettingProps): React.JSX.Element {
  const t = useTranslate()
  const entry = getChatBehaviorEntriesByKey().shellEnvironment
  const hostLabel = useSettingsHostLabel(hostScope.target)
  const hostArgs = {
    owner: hostScope.target,
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  }
  const inherit = useHostSetting({ ...hostArgs, settingKey: 'nativeChatInheritShellEnvironment' })
  const names = useHostSetting({ ...hostArgs, settingKey: 'nativeChatShellEnvironmentVariables' })
  const ready =
    hostScope.available && inherit.setting.state === 'ready' && names.setting.state === 'ready'
  const unsupported =
    inherit.setting.state === 'unsupported' || names.setting.state === 'unsupported'
  const inheritAll = inherit.setting.state !== 'ready' || inherit.setting.value
  const savedNames = names.setting.state === 'ready' ? names.setting.value : []

  return (
    <div className="space-y-3 pb-3">
      <SettingsSwitchRow
        className="pb-0"
        label={entry.title}
        description={unsupported ? getHostSettingUnsupportedNote(hostLabel, t) : entry.description}
        checked={inheritAll}
        disabled={!ready}
        ariaLabel={t(
          'auto.components.settings.ExperimentalPane.nativeChat.shellEnvToggleLabel',
          'Toggle using your shell environment'
        )}
        onChange={() => void inherit.update(!inheritAll)}
      />
      {inheritAll || !ready ? null : (
        <ShellEnvironmentNamesField
          savedNames={savedNames}
          onChange={(next) => void names.update(next)}
        />
      )}
    </div>
  )
}
