// Where each safety-check flag of a share candidate is, in the Share dialog's words and pages.
import { translate } from '@/i18n/i18n'
import type { BotShareFlag } from '../../../../../shared/bots/bot-package'
import type { BotShareFlagSpot } from '../../../../../shared/bots/bot-share-flag-spots'
import type { BotSharePage } from './bot-share-pages'

export function botShareFlagLabel(kind: BotShareFlag['kind']): string {
  switch (kind) {
    case 'secret':
      return translate('bots.share.flag.secret', 'Secret')
    case 'pipe-to-shell':
      return translate('bots.share.flag.pipeToShell', 'Runs a downloaded script')
    case 'sudo':
      return translate('bots.share.flag.sudo', 'Runs as administrator')
    case 'sends-file':
      return translate('bots.share.flag.sendsFile', 'Sends a file')
    case 'hidden-unicode':
      return translate('bots.share.flag.hiddenUnicode', 'Hidden characters')
    case 'runnable':
      return translate('bots.share.flag.runnable', 'Runnable file')
  }
}

/** The safety check's one-line value: a secret first, then warnings, else nothing. */
export function botShareCheckSummary(spots: readonly BotShareFlagSpot[]): string {
  const secrets = spots.filter((spot) => spot.flag.kind === 'secret').length
  if (secrets > 0) {
    return secrets === 1
      ? translate('bots.share.secretFound', '1 secret found')
      : translate('bots.share.secretsFound', '{{count}} secrets found', { count: secrets })
  }
  if (spots.length > 0) {
    return spots.length === 1
      ? translate('bots.share.oneWarning', '1 warning')
      : translate('bots.share.warnings', '{{count}} warnings', { count: spots.length })
  }
  return translate('bots.share.nothingFound', 'Nothing found')
}

/** "release-process, line 6": where a flag is, for its row. */
export function botShareFlagWhere(spot: BotShareFlagSpot): string {
  return spot.flag.line === null
    ? spot.where
    : translate('bots.share.whereLine', '{{where}}, line {{line}}', {
        where: spot.where,
        line: spot.flag.line
      })
}

/** The page that shows a flag's text; null when nothing shows it. */
export function botShareFlagPage(spot: BotShareFlagSpot): BotSharePage | null {
  if (!spot.part) {
    return null
  }
  return {
    kind: 'part',
    part: spot.part,
    title: spot.where,
    ...(spot.part.startsWith('memory:')
      ? { detail: translate('bots.share.memory', 'Memory') }
      : { showNames: spot.part.startsWith('skill:') })
  }
}
