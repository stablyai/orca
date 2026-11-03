import { translate } from '@/i18n/i18n'

export function sourceControlModelLabel(model: { id: string; label: string }): string {
  if (model.id === 'default' && model.label === 'Config default') {
    return translate('sourceControl.model.configDefault', 'Config default')
  }
  if (model.id === 'auto' && model.label === 'Auto') {
    return translate('sourceControl.model.auto', 'Auto')
  }
  return model.label
}

export function sourceControlThinkingLabel(level: { id: string; label: string }): string {
  switch (level.id) {
    case 'off':
      return translate('sourceControl.thinking.off', 'Off')
    case 'minimal':
      return translate('sourceControl.thinking.minimal', 'Minimal')
    case 'low':
      return translate('sourceControl.thinking.low', 'Low')
    case 'medium':
      return translate('sourceControl.thinking.medium', 'Medium')
    case 'high':
      return translate('sourceControl.thinking.high', 'High')
    case 'xhigh':
      return translate('sourceControl.thinking.xhigh', 'Extra High')
    case 'max':
      return translate('sourceControl.thinking.max', 'Max')
    default:
      return level.label
  }
}
