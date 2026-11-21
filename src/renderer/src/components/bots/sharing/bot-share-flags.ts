// Where each safety-check flag of a share candidate is, in the Share dialog's words and pages.
import { translate } from '@/i18n/i18n'
import type {
  BotPackageV1,
  BotShareCandidateSummary,
  BotShareFlag
} from '../../../../../shared/bots/bot-package'
import type { BotSharePage } from './bot-share-pages'

/** A flag placed: the dialog page that shows it, the file on that page, and where it lives in the
 *  bot home (null for text kept in bot.json, which has no file to open). */
export type BotShareFlagSpot = {
  flag: BotShareFlag
  /** A `bots.share.view` part, or null for no page. */
  part: string | null
  where: string
  file: string
  homePath: string | null
}

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

/** What placing a flag reads of a candidate. */
type FlagSource = Pick<BotShareCandidateSummary, 'automationIds'> & {
  /** Files whose shared lines aren't the home file's: no line of theirs opens in the home. */
  rewritten?: readonly string[]
  bot: Pick<BotPackageV1, 'tools' | 'schedules' | 'eventSuggestions'>
  available: Pick<BotShareCandidateSummary['available'], 'skills'>
}

const MANIFEST_FIELD = /^bot\.json#(schedules|eventSuggestions|tools)\.(\d+)\./

function manifestSpot(
  flag: BotShareFlag,
  field: string,
  candidate: FlagSource
): Omit<BotShareFlagSpot, 'flag'> {
  const match = MANIFEST_FIELD.exec(flag.where)
  const { bot } = candidate
  if (match?.[1] === 'tools') {
    const tool = bot.tools[Number(match[2])]
    if (tool) {
      return { part: `tool:${tool.name}`, where: tool.name, file: tool.name, homePath: null }
    }
  }
  if (match?.[1] === 'schedules' || match?.[1] === 'eventSuggestions') {
    const index = Number(match[2])
    const shared = bot[match[1]][index]
    const automationId = candidate.automationIds[match[1]][index]
    if (shared && automationId) {
      const kind = match[1] === 'schedules' ? 'schedule' : 'event'
      return {
        part: `${kind}:${automationId}`,
        where: shared.name,
        file: shared.name,
        homePath: null
      }
    }
  }
  return { part: null, where: field, file: field, homePath: null }
}

function placeFlag(flag: BotShareFlag, candidate: FlagSource): BotShareFlagSpot {
  if (flag.where.startsWith('bot.json#')) {
    return { flag, ...manifestSpot(flag, flag.where.slice('bot.json#'.length), candidate) }
  }
  if (flag.where === 'SOUL.md') {
    return { flag, part: 'soul', where: 'SOUL.md', file: 'SOUL.md', homePath: 'SOUL.md' }
  }
  const memory = /^memory\/(.+)\.md$/.exec(flag.where)
  if (memory) {
    return {
      flag,
      part: `memory:${memory[1]}`,
      where: memory[1],
      file: flag.where,
      homePath: flag.where
    }
  }
  const skill = /^skills\/([^/]+)\/(.+)$/.exec(flag.where)
  const own = skill && candidate.available.skills.find((entry) => entry.name === skill[1])
  if (skill && own) {
    return {
      flag,
      part: `skill:${skill[1]}`,
      where: `${skill[1]} › ${skill[2]}`,
      file: skill[2],
      homePath: own.homePath === null ? null : `${own.homePath}/${skill[2]}`
    }
  }
  return { flag, part: null, where: flag.where, file: flag.where, homePath: null }
}

export function botShareFlagSpot(flag: BotShareFlag, candidate: FlagSource): BotShareFlagSpot {
  const spot = placeFlag(flag, candidate)
  return candidate.rewritten?.includes(flag.where) ? { ...spot, homePath: null } : spot
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
