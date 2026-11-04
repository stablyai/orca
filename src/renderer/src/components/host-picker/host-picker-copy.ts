import { translate } from '@/i18n/i18n'

export function searchHostsLabel(): string {
  return translate('auto.components.hostPicker.searchHosts', 'Search hosts…')
}

export function noHostsMatchLabel(): string {
  return translate('auto.components.hostPicker.noHostsMatch', 'No hosts match.')
}

export function moreHostsLabel(count: number): string {
  return translate(
    'auto.components.hostPicker.moreHosts',
    '{{count}} more hosts. Search by name to find one.',
    { count, defaultValue_one: '{{count}} more host. Search by name to find it.' }
  )
}
