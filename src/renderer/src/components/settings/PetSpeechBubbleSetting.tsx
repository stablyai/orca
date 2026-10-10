import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Input } from '../ui/input'
import { NumberField, SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { defaultSpeechText } from '../pet/PetSpeechBubble'
import {
  PET_SPEECH_REMINDER_MINUTES_DEFAULT,
  PET_SPEECH_REMINDER_MINUTES_MAX,
  type PetSpeechKind
} from '../pet/pet-speech-bubble'

type TextSettingKey = 'petSpeechDoneText' | 'petSpeechWaitingText' | 'petSpeechReminderText'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

function SpeechTextField({
  label,
  kind,
  settingKey,
  settings,
  updateSettings
}: Props & { label: string; kind: PetSpeechKind; settingKey: TextSettingKey }): React.JSX.Element {
  const value = settings[settingKey] ?? ''
  const [draft, setDraft] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value)
  }
  const commit = (): void => {
    if (draft.trim() !== value.trim()) {
      updateSettings({ [settingKey]: draft.trim() })
    }
  }

  return (
    <SettingsRow
      className="py-0"
      label={label}
      control={
        <Input
          value={draft}
          aria-label={label}
          placeholder={defaultSpeechText(kind)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commit()
            }
          }}
          className="w-64"
        />
      }
    />
  )
}

export function PetSpeechBubbleSetting({ settings, updateSettings }: Props): React.JSX.Element {
  const enabled = settings.petSpeechBubbles !== false

  return (
    <div className="ml-4 space-y-3 border-l border-border pl-4">
      <SettingsSwitchRow
        className="py-0"
        label={translate('auto.components.settings.PetSpeechBubbleSetting.title', 'Speech bubbles')}
        description={translate(
          'auto.components.settings.PetSpeechBubbleSetting.description',
          'The pet speaks up when an agent finishes or needs your input. Click a bubble to dismiss it.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ petSpeechBubbles: !enabled })}
      />
      {enabled ? (
        <>
          <SpeechTextField
            label={translate(
              'auto.components.settings.PetSpeechBubbleSetting.doneLabel',
              'When an agent finishes'
            )}
            kind="done"
            settingKey="petSpeechDoneText"
            settings={settings}
            updateSettings={updateSettings}
          />
          <SpeechTextField
            label={translate(
              'auto.components.settings.PetSpeechBubbleSetting.waitingLabel',
              'When an agent needs input'
            )}
            kind="waiting"
            settingKey="petSpeechWaitingText"
            settings={settings}
            updateSettings={updateSettings}
          />
          <SpeechTextField
            label={translate(
              'auto.components.settings.PetSpeechBubbleSetting.reminderLabel',
              'Reminder'
            )}
            kind="reminder"
            settingKey="petSpeechReminderText"
            settings={settings}
            updateSettings={updateSettings}
          />
          <NumberField
            className="py-0"
            label={translate(
              'auto.components.settings.PetSpeechBubbleSetting.reminderMinutesLabel',
              'Remind every'
            )}
            description={translate(
              'auto.components.settings.PetSpeechBubbleSetting.reminderMinutesDescription',
              'Repeat the reminder while finished or waiting agents stay unchecked. {count} in the text becomes the number of agents. 0 turns reminders off.'
            )}
            value={settings.petSpeechReminderMinutes ?? PET_SPEECH_REMINDER_MINUTES_DEFAULT}
            defaultValue={PET_SPEECH_REMINDER_MINUTES_DEFAULT}
            min={0}
            max={PET_SPEECH_REMINDER_MINUTES_MAX}
            integer
            suffix={translate(
              'auto.components.settings.PetSpeechBubbleSetting.reminderMinutesSuffix',
              'minutes'
            )}
            onChange={(minutes) => updateSettings({ petSpeechReminderMinutes: minutes })}
          />
        </>
      ) : null}
    </div>
  )
}
