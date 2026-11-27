import type { Translate } from '@/i18n/use-translate'

/**
 * The Filters menu Bot row's visible label and accessible name. The name embeds the rendered label
 * whole, so it contains the visible text (WCAG 2.5.3) however much of a language pack is translated.
 */
export function botFilterRowNames(
  t: Translate,
  name: string
): { label: string; accessibleName: string } {
  const label = `${t('auto.components.automations.AutomationListFilterMenu.bot', 'Bot')}: ${name}`
  return {
    label,
    accessibleName: t(
      'auto.components.automations.AutomationListFilterMenu.botFilterRowRemoveLabel',
      '{{label}}, remove filter',
      { label }
    )
  }
}
