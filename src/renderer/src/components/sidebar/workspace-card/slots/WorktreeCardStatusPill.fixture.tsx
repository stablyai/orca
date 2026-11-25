import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { useIntlLocale } from '@/i18n/use-translate'
import type { SupportedUiLocale } from '../../../../../../shared/i18n/ui-locale'
import { WorktreeCardStatusPill } from './WorktreeCardSlot'
import { BotRowLineText } from '../../../bots/BotRowActivityLine'

function CompactPillSamples(): React.JSX.Element {
  const locale = useIntlLocale()
  return (
    <div className="flex flex-col items-start gap-2">
      {[1, 2, 21].map((count) => (
        <div key={count} className="flex flex-col items-start gap-1 text-xs">
          <WorktreeCardStatusPill signal={{ kind: 'needs', count }} />
          <BotRowLineText key={locale} line={{ kind: 'needYouElsewhere', count }} now={0} />
        </div>
      ))}
    </div>
  )
}

function compactPills(locale: SupportedUiLocale, width = 252) {
  return defineFixture({
    width,
    render: () => <CompactPillSamples />,
    interact: async () => setRendererUiLanguage(locale)
  })
}

export const chinese = compactPills('zh')
export const traditionalChinese = compactPills('zh-Hant')
export const french = compactPills('fr')
export const japanese = compactPills('ja')
export const korean = compactPills('ko')
export const russian = compactPills('ru')
export const german = compactPills('de')
export const spanish = compactPills('es')
export const portuguese = compactPills('pt')
export const turkish = compactPills('tr')
export const chineseNormal = compactPills('zh', 352)
export const traditionalChineseNormal = compactPills('zh-Hant', 352)
export const frenchNormal = compactPills('fr', 352)
export const japaneseNormal = compactPills('ja', 352)
export const koreanNormal = compactPills('ko', 352)
export const russianNormal = compactPills('ru', 352)
export const germanNormal = compactPills('de', 352)
export const spanishNormal = compactPills('es', 352)
export const portugueseNormal = compactPills('pt', 352)
export const turkishNormal = compactPills('tr', 352)
