import { translate } from '@/i18n/i18n'

export function agentChildDisclosureLabel(expanded: boolean, count: number): string {
  if (expanded) {
    return count === 1
      ? translate('components.agent-child-disclosure.hide-one', 'Hide 1 child agent')
      : translate('components.agent-child-disclosure.hide-other', 'Hide {{count}} child agents', {
          count
        })
  }
  return count === 1
    ? translate('components.agent-child-disclosure.show-one', 'Show 1 child agent')
    : translate('components.agent-child-disclosure.show-other', 'Show {{count}} child agents', {
        count
      })
}
