import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  normalizeNativeChatSpeechSettings,
  resolveNativeChatSpeechSettings,
  type NativeChatSpeechEngine,
  type NativeChatSpeechVoice,
  type ResolvedNativeChatSpeech
} from '../../../../../shared/native-chat/native-chat-speech'
import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../form-controls/SettingsFormControls'
import { matchesSettingsSearch } from '../search/settings-search'
import { getChatSpeechEntriesByKey, getChatSpeechTitle } from './chat-speech-search'
import { useTranslate } from '../../../i18n/use-translate'

type ChatSpeechSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  showEngine: boolean
  forceVisible?: boolean
}

const RATES = [0.8, 1, 1.2] as const

/** How a finished agent reply is read aloud. The neural engine stays on the desktop. */
export function ChatSpeechSetting({
  settings,
  updateSettings,
  showEngine,
  forceVisible = false
}: ChatSpeechSettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const query = useAppStore((state) => state.settingsSearchQuery)
  const entries = getChatSpeechEntriesByKey()
  const rows = [
    entries.enabled,
    entries.rate,
    entries.auto,
    ...(showEngine ? [entries.engine] : [])
  ]
  if (!forceVisible && !matchesSettingsSearch(query, [{ title: getChatSpeechTitle(t) }, ...rows])) {
    return null
  }
  const speech = resolveNativeChatSpeechSettings(settings.nativeChatSpeech)
  const write = (patch: Partial<ResolvedNativeChatSpeech>): void => {
    void updateSettings({
      nativeChatSpeech: normalizeNativeChatSpeechSettings({ ...speech, ...patch })
    })
  }
  const controlsDisabled = !speech.enabled
  return (
    <SettingsGroup id="chat-speech" title={getChatSpeechTitle(t)}>
      <SearchableSetting {...entries.enabled} id="chat-speech-enabled" forceVisible={forceVisible}>
        <SettingsSwitchRow
          label={entries.enabled.title}
          description={entries.enabled.description}
          checked={speech.enabled}
          ariaLabel={entries.enabled.title}
          onChange={() => write({ enabled: !speech.enabled })}
        />
      </SearchableSetting>
      {showEngine ? (
        <SearchableSetting
          {...entries.engine}
          id={entries.engine.targetSectionId}
          forceVisible={forceVisible}
        >
          <SettingsRow
            label={entries.engine.title}
            description={entries.engine.description}
            control={
              <SettingsSegmentedControl<NativeChatSpeechEngine>
                size="sm"
                ariaLabel={entries.engine.title}
                value={speech.engine}
                onChange={(engine) => write({ engine })}
                options={[
                  {
                    value: 'web-speech',
                    label: t('components.settings.nativeChat.speechEngineSystem', 'System'),
                    disabled: controlsDisabled
                  },
                  {
                    value: 'edge',
                    label: t('components.settings.nativeChat.speechEngineNeural', 'Neural'),
                    disabled: controlsDisabled
                  }
                ]}
              />
            }
          />
          {speech.engine === 'edge' ? (
            <SettingsRow
              label={t('components.settings.nativeChat.speechVoiceTitle', 'Voice')}
              control={
                <SettingsSegmentedControl<NativeChatSpeechVoice>
                  size="sm"
                  ariaLabel={t('components.settings.nativeChat.speechVoiceTitle', 'Voice')}
                  value={speech.voice}
                  onChange={(voice) => write({ voice })}
                  options={[
                    {
                      value: 'ru-RU-SvetlanaNeural',
                      label: t('components.settings.nativeChat.speechVoiceSvetlana', 'Svetlana'),
                      disabled: controlsDisabled
                    },
                    {
                      value: 'ru-RU-DmitryNeural',
                      label: t('components.settings.nativeChat.speechVoiceDmitry', 'Dmitry'),
                      disabled: controlsDisabled
                    }
                  ]}
                />
              }
            />
          ) : null}
        </SearchableSetting>
      ) : null}
      <SearchableSetting
        {...entries.rate}
        id={entries.rate.targetSectionId}
        forceVisible={forceVisible}
      >
        <SettingsRow
          label={entries.rate.title}
          description={entries.rate.description}
          control={
            <SettingsSegmentedControl<number>
              size="sm"
              ariaLabel={entries.rate.title}
              value={displayedRate(speech.rate)}
              onChange={(rate) => write({ rate })}
              options={RATES.map((rate) => ({
                value: rate,
                label: rateLabel(t, rate),
                disabled: controlsDisabled
              }))}
            />
          }
        />
      </SearchableSetting>
      <SearchableSetting
        {...entries.auto}
        id={entries.auto.targetSectionId}
        forceVisible={forceVisible}
      >
        <SettingsSwitchRow
          label={entries.auto.title}
          description={entries.auto.description}
          checked={speech.auto}
          disabled={controlsDisabled}
          ariaLabel={entries.auto.title}
          onChange={() => write({ auto: !speech.auto })}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}

function displayedRate(rate: number): (typeof RATES)[number] {
  if (rate <= 0.9) {
    return 0.8
  }
  if (rate >= 1.1) {
    return 1.2
  }
  return 1
}

function rateLabel(
  t: (key: string, fallback: string) => string,
  rate: (typeof RATES)[number]
): string {
  if (rate === 0.8) {
    return t('components.settings.nativeChat.speechRateSlower', 'Slower')
  }
  if (rate === 1.2) {
    return t('components.settings.nativeChat.speechRateFaster', 'Faster')
  }
  return t('components.settings.nativeChat.speechRateNormal', 'Normal')
}
