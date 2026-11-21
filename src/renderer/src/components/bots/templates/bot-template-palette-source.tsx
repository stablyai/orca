import { useMemo } from 'react'
import {
  matchPaletteExtraFields,
  type PaletteExtraResult,
  type PaletteExtraSource
} from '@/components/cmd-j/palette-extra-results'
import { useTranslate } from '@/i18n/use-translate'
import { useBotsEnabled } from '@/lib/bot-catalog'
import { BOT_TEMPLATES } from '../../../../../shared/bots/bot-templates'
import { botTemplateText } from '../../../../../shared/bots/bot-template-text'
import { BotTemplateMascot } from './BotTemplateMascot'
import { openBotTemplates } from './bot-templates-open'

/** Bot templates in Cmd+J, for a typed query only; Enter opens the Bot templates dialog on that template. */
export function useBotTemplatePaletteSource({
  query,
  visible
}: {
  query: string
  visible: boolean
}): PaletteExtraSource | null {
  const t = useTranslate()
  const shown = useBotsEnabled()
  const results = useMemo((): PaletteExtraResult[] => {
    if (!shown || !visible || !query.trim()) {
      return []
    }
    return BOT_TEMPLATES.flatMap((template, order): PaletteExtraResult[] => {
      const id = `bot-template:${template.id}`
      const name = botTemplateText(template.name, t)
      const line = botTemplateText(template.line, t)
      const match = matchPaletteExtraFields(
        id,
        [
          { id: 'name', text: name, role: 'primary' },
          { id: 'line', text: line, role: 'secondary' },
          // Why: English still finds a template whose words show translated.
          ...(name === template.name
            ? []
            : [{ id: 'englishName', text: template.name, role: 'secondary' as const }]),
          ...(line === template.line
            ? []
            : [{ id: 'englishLine', text: template.line, role: 'secondary' as const }])
        ],
        query
      )
      return match
        ? [
            {
              id,
              title: name,
              titleRanges: match.rangesByField.get('name') ?? [],
              rank: match.rank,
              qualityClass: match.qualityClass,
              lastActiveAt: null,
              order,
              leading: <BotTemplateMascot template={template} className="size-4 rounded" />,
              line: t('bots.templates.paletteLine', 'Bot template'),
              onSelect: () => openBotTemplates(template.id)
            }
          ]
        : []
    })
  }, [query, shown, t, visible])
  return useMemo(
    () =>
      shown
        ? {
            id: 'bot-templates',
            sectionLabel: (translate) => translate('bots.templates.title', 'Bot templates'),
            emptyQueryCap: 0,
            typedPlacement: 'after-workspaces',
            leadsOnTie: false,
            results
          }
        : null,
    [results, shown]
  )
}
