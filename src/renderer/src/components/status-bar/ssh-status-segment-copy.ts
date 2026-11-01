import { translate } from '@/i18n/i18n'

export function connectedHostCountLabel(count: number): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.connectedHostCount',
    '{{count}} hosts',
    { count, defaultValue_one: '{{count}} host' }
  )
}

export function moreSshHostsLabel(count: number): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.moreSshHosts',
    'Find among {{count}} more SSH hosts…',
    { count, defaultValue_one: 'Find {{count}} more SSH host…' }
  )
}

export function searchSshHostsLabel(): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.searchSshHosts',
    'Search SSH hosts…'
  )
}

export function noMatchingSshHostsLabel(): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.noMatchingSshHosts',
    'No SSH hosts match.'
  )
}

export function moreSshHostMatchesLabel(count: number): string {
  return translate(
    'auto.components.status.bar.SshStatusSegment.moreSshHostMatches',
    '{{count}} more matches. Keep typing to narrow them down.',
    { count, defaultValue_one: '{{count}} more match. Keep typing to narrow it down.' }
  )
}
