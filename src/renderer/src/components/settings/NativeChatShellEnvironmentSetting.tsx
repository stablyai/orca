import { useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isNativeChatShellEnvironmentName } from '../../../../shared/native-chat-shell-environment'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SettingsSwitch } from './SettingsFormControls'

type NativeChatShellEnvironmentSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

const NAME_INPUT_ID = 'settings-native-chat-shell-environment-name'

function ShellEnvironmentNamesField({
  savedNames,
  onChange
}: {
  savedNames: readonly string[]
  onChange: (names: string[]) => void
}): React.JSX.Element {
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
        {translate(
          'auto.components.settings.ChatPane.shellEnvNamesLabel',
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
          placeholder={translate(
            'auto.components.settings.ChatPane.shellEnvNamePlaceholder',
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
          {translate('auto.components.settings.ChatPane.shellEnvNameAdd', 'Add')}
        </Button>
      </div>
      {savedNames.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ChatPane.shellEnvNamesEmpty',
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
                aria-label={translate(
                  'auto.components.settings.ChatPane.shellEnvNameRemove',
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
        {translate(
          'auto.components.settings.ChatPane.shellEnvNamesAlwaysPassed',
          'PATH, locale, and SSH_AUTH_SOCK are always passed. Applies the next time a chat starts or resumes.'
        )}
      </p>
    </div>
  )
}

export function NativeChatShellEnvironmentSetting({
  settings,
  updateSettings
}: NativeChatShellEnvironmentSettingProps): React.JSX.Element {
  const inheritAll = settings.nativeChatInheritShellEnvironment !== false
  const savedNames = settings.nativeChatShellEnvironmentVariables ?? []

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.ChatPane.shellEnvTitle',
              'Use your shell environment'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.ChatPane.shellEnvCopy',
              'Codex and Claude chats start with every variable your login shell exports, the same as a terminal. Turn off to choose which ones they get.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={inheritAll}
          ariaLabel={translate(
            'auto.components.settings.ChatPane.shellEnvToggleLabel',
            'Toggle using your shell environment'
          )}
          onChange={() => updateSettings({ nativeChatInheritShellEnvironment: !inheritAll })}
        />
      </div>
      {inheritAll ? null : (
        <ShellEnvironmentNamesField
          savedNames={savedNames}
          onChange={(names) => updateSettings({ nativeChatShellEnvironmentVariables: names })}
        />
      )}
    </div>
  )
}
