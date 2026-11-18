// The template pages' words for a category and for when a template's bot runs.
import type { Translate } from '@/i18n/use-translate'
import type { BotTemplateCategory } from '../../../../../shared/bots/bot-templates'
import type { BotTemplateWhen } from '../../../../../shared/bots/bot-template-view'

export function botTemplateCategoryLabel(category: BotTemplateCategory, t: Translate): string {
  switch (category) {
    case 'coding':
      return t('bots.templates.category.coding', 'Coding')
    case 'releases':
      return t('bots.templates.category.releases', 'Releases & CI')
    case 'support':
      return t('bots.templates.category.support', 'Support & feedback')
    case 'planning':
      return t('bots.templates.category.planning', 'Planning & docs')
    case 'ops':
      return t('bots.templates.category.ops', 'Ops')
    case 'personal':
      return t('bots.templates.category.personal', 'Personal follow-ups')
  }
}

export function botTemplateWhenLabel(when: BotTemplateWhen, t: Translate): string {
  switch (when.kind) {
    case 'schedule':
      return when.short
    case 'events':
      return t('bots.templates.whenEvents', 'On events')
    case 'asked':
      return t('bots.templates.whenAsked', 'When you ask')
  }
}
