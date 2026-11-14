import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function sourceControlModelLabel(
  model: { id: string; label: string },
  t: Translate = translate
): string {
  if (model.id === 'default' && model.label === 'Config default') {
    return t('sourceControl.model.configDefault', 'Config default')
  }
  if (model.id === 'auto' && model.label === 'Auto') {
    return t('sourceControl.model.auto', 'Auto')
  }
  return model.label
}

export function sourceControlThinkingLabel(
  level: { id: string; label: string },
  t: Translate = translate
): string {
  switch (level.id) {
    case 'off':
      return t('sourceControl.thinking.off', 'Off')
    case 'minimal':
      return t('sourceControl.thinking.minimal', 'Minimal')
    case 'low':
      return t('sourceControl.thinking.low', 'Low')
    case 'medium':
      return t('sourceControl.thinking.medium', 'Medium')
    case 'high':
      return t('sourceControl.thinking.high', 'High')
    case 'xhigh':
      return t('sourceControl.thinking.xhigh', 'Extra High')
    case 'max':
      return t('sourceControl.thinking.max', 'Max')
    default:
      return level.label
  }
}
