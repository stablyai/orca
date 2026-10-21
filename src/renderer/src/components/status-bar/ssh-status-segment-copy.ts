import { translate } from '@/i18n/i18n'

export function connectedHostCountLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_one',
        '{{count}} host',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.connectedHostCount_other',
        '{{count}} hosts',
        { count }
      )
}

export function connectingHostsLabel(): string {
  return translate('auto.components.status.bar.SshStatusSegment.connecting', 'Connecting…')
}

export function moreSshHostsLabel(count: number): string {
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_one',
        'Find {{count}} more SSH host…',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHosts_other',
        'Find among {{count}} more SSH hosts…',
        { count }
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
  return count === 1
    ? translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHostMatches_one',
        '{{count}} more match. Keep typing to narrow it down.',
        { count }
      )
    : translate(
        'auto.components.status.bar.SshStatusSegment.moreSshHostMatches_other',
        '{{count}} more matches. Keep typing to narrow them down.',
        { count }
      )
}
