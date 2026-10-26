import { useId } from 'react'
import type { VoiceSettings } from '../../../../shared/speech-types'
import type { UiLanguage } from '../../../../shared/ui-language'
import { resolveRendererUiLocale, SUPPORTED_UI_LOCALES } from '../../../../shared/ui-locale'
import { translate } from '@/i18n/i18n'
import { getUiLanguageNativeLabel } from '@/i18n/supported-languages'
import { useLocalSpeechVoices } from '../dictation/use-local-speech-voices'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export function VoiceConversationPreferences({
  settings,
  uiLanguage,
  onUpdate
}: {
  settings: VoiceSettings
  uiLanguage: UiLanguage
  onUpdate: (updates: Partial<VoiceSettings>) => void
}): React.JSX.Element {
  const id = useId()
  const { voices, refresh } = useLocalSpeechVoices()
  const language = settings.conversationLanguage ?? resolveRendererUiLocale(uiLanguage)
  const matching = voices.filter((voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === language)
  const selected = matching.some((voice) => voice.voiceURI === settings.localVoiceUri)
    ? settings.localVoiceUri
    : 'auto'
  return (
    <section className="space-y-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`${id}-language`}>
          {translate('stsPreferences.language', 'Conversation language')}
        </Label>
        <Select
          value={settings.conversationLanguage ?? 'app'}
          onValueChange={(value) => {
            onUpdate({
              conversationLanguage: SUPPORTED_UI_LOCALES.find((locale) => locale === value)
            })
          }}
        >
          <SelectTrigger id={`${id}-language`} className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="app">
              {translate('stsPreferences.appLanguage', 'Follow app language')}
            </SelectItem>
            {SUPPORTED_UI_LOCALES.map((locale) => (
              <SelectItem key={locale} value={locale}>
                {getUiLanguageNativeLabel(locale)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {settings.ttsProvider !== 'elevenlabs' && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label htmlFor={`${id}-voice`}>
              {translate('stsPreferences.localVoice', 'Installed system voice')}
            </Label>
            <Select
              value={selected}
              onValueChange={(value) =>
                onUpdate({ localVoiceUri: value === 'auto' ? undefined : value })
              }
            >
              <SelectTrigger id={`${id}-voice`} className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  {translate('stsPreferences.automatic', 'Automatic for this language')}
                </SelectItem>
                {matching.map((voice) => (
                  <SelectItem key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} · {voice.lang}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {matching.length === 0 && (
            <p role="status" className="text-xs text-muted-foreground">
              {translate(
                'stsPreferences.noVoices',
                'No local voice is available for this language. Install a system voice or select ElevenLabs output below.'
              )}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {translate(
              'stsPreferences.install',
              'Install voices in your system’s speech or accessibility settings, then refresh. Only voices exposed to this app appear; availability varies by system.'
            )}
          </p>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Button variant="outline" size="sm" onClick={refresh}>
              {translate('stsPreferences.refresh', 'Refresh voices')}
            </Button>
            <a
              className="underline"
              href="https://support.microsoft.com/en-us/accessibility/windows/narrator/appendix-a-supported-languages-and-voices"
              target="_blank"
              rel="noopener noreferrer"
            >
              {translate('stsPreferences.windows', 'Windows voice installation')}
            </a>
            <a
              className="underline"
              href="https://support.apple.com/guide/mac-help/mchlp2290/mac"
              target="_blank"
              rel="noopener noreferrer"
            >
              {translate('stsPreferences.mac', 'macOS voice installation')}
            </a>
          </div>
        </>
      )}
    </section>
  )
}
