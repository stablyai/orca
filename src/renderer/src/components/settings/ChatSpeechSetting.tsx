import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  normalizeNativeChatSpeechSettings,
  resolveNativeChatSpeechSettings,
  type NativeChatSpeechEngine,
  type NativeChatSpeechVoice,
  type ResolvedNativeChatSpeech
} from '../../../../shared/native-chat-speech'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Card, CardContent } from '../ui/card'
import { SearchableSetting } from './SearchableSetting'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { getChatSpeechEntriesByKey, getChatSpeechTitle } from './chat-speech-search'
import { matchesSettingsSearch } from './settings-search'

type ChatSpeechSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
  showEngine: boolean
  forceVisible?: boolean
}

const RATES = [0.8, 1, 1.2] as const

export function ChatSpeechSetting({
  settings,
  updateSettings,
  showEngine,
  forceVisible = false
}: ChatSpeechSettingProps): React.JSX.Element | null {
  const query = useAppStore((state) => state.settingsSearchQuery)
  const entries = getChatSpeechEntriesByKey()
  const rows = [
    entries.enabled,
    entries.rate,
    entries.auto,
    ...(showEngine ? [entries.engine] : [])
  ]
  if (!forceVisible && !matchesSettingsSearch(query, [{ title: getChatSpeechTitle() }, ...rows])) {
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
    <section id="chat-speech" className="space-y-3">
      <SettingsSubsectionHeader title={getChatSpeechTitle()} />
      <Card>
        <CardContent>
          <div className="divide-y divide-border/40">
            <SearchableSetting
              {...entries.enabled}
              id="chat-speech-enabled"
              forceVisible={forceVisible}
              className="max-w-none"
            >
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
                className="max-w-none"
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
                          label: translate(
                            'components.settings.nativeChat.speechEngineSystem',
                            'System'
                          ),
                          disabled: controlsDisabled
                        },
                        {
                          value: 'edge',
                          label: translate(
                            'components.settings.nativeChat.speechEngineNeural',
                            'Neural'
                          ),
                          disabled: controlsDisabled
                        }
                      ]}
                    />
                  }
                />
                {speech.engine === 'edge' ? (
                  <SettingsRow
                    label={translate('components.settings.nativeChat.speechVoiceTitle', 'Voice')}
                    control={
                      <SettingsSegmentedControl<NativeChatSpeechVoice>
                        size="sm"
                        ariaLabel={translate(
                          'components.settings.nativeChat.speechVoiceTitle',
                          'Voice'
                        )}
                        value={speech.voice}
                        onChange={(voice) => write({ voice })}
                        options={[
                          {
                            value: 'ru-RU-SvetlanaNeural',
                            label: translate(
                              'components.settings.nativeChat.speechVoiceSvetlana',
                              'Svetlana'
                            ),
                            disabled: controlsDisabled
                          },
                          {
                            value: 'ru-RU-DmitryNeural',
                            label: translate(
                              'components.settings.nativeChat.speechVoiceDmitry',
                              'Dmitry'
                            ),
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
              className="max-w-none"
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
                      label: rateLabel(rate),
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
              className="max-w-none"
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
          </div>
        </CardContent>
      </Card>
    </section>
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

function rateLabel(rate: (typeof RATES)[number]): string {
  if (rate === 0.8) {
    return translate('components.settings.nativeChat.speechRateSlower', 'Slower')
  }
  if (rate === 1.2) {
    return translate('components.settings.nativeChat.speechRateFaster', 'Faster')
  }
  return translate('components.settings.nativeChat.speechRateNormal', 'Normal')
}
