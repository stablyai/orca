// Row states for a bot's settings: the short value at a Settings row's end, and the longer lines its pages show.
import { translate } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { BotTools } from '../../../../shared/bot-tools'
import type { BotLookAround, LookAroundEvery } from '../../../../shared/bots/bot-look-around'
import {
  botLookAroundLine,
  botTidyUpLine,
  type BotSettingsLineWords
} from '../../../../shared/bots/bot-settings-row-lines'
import type { BotTidyUp } from '../../../../shared/bots/bot-tidy-up'
import { botToolsLine } from '../../../../shared/bots/bot-tool-labels'

const none = (): string => translate('bots.settingsPage.none', 'None')

/** Names as a short list: "Slack, GitHub". */
export function nameList(names: readonly string[], intlLocale?: string): string {
  // Why: CJK unit lists have no separator ("SlackGitHub"); narrow conjunctions read "Slack、GitHub".
  return new Intl.ListFormat(intlLocale, { type: 'conjunction', style: 'narrow' }).format(names)
}

const LINE_WORDS: BotSettingsLineWords = {
  t: translate,
  format: (at, options) => uiDateTimeFormat(options).format(at)
}

/** "Every 4 hours, 8 AM to 8 PM · last looked 12:04 PM". */
export function lookAroundLine(setting: BotLookAround, lastLookedAt: number | undefined): string {
  return botLookAroundLine(setting, lastLookedAt, LINE_WORDS)
}

/** "Each night after 3 AM, or once this computer is awake · last tidied today". */
export function tidyUpLine(setting: BotTidyUp, lastTidiedAt: number | undefined): string {
  return botTidyUpLine(setting, lastTidiedAt, {
    ...LINE_WORDS,
    tidyEvery: (every) =>
      every === 'night'
        ? translate(
            'settings.bots.tidyUp.everyNightLine',
            'Each night after 3 AM, or once this computer is awake'
          )
        : translate(
            'settings.bots.tidyUp.everyWeekLine',
            'Once a week after 3 AM, or once this computer is awake'
          )
  })
}

/** "7 files": MEMORY.md and its topic files; null before the folder is read. */
export function memoryValue(topicFiles: number | null): string | null {
  return topicFiles === null
    ? null
    : translate('bots.settingsView.memoryFiles', '{{count}} files', {
        count: topicFiles + 1,
        defaultValue_one: '{{count}} file'
      })
}

const LOOK_AROUND_SHORT: Record<LookAroundEvery, () => string> = {
  'every-4h': () => translate('bots.settingsView.lookAroundShort.every4h', '4h'),
  'every-2h': () => translate('bots.settingsView.lookAroundShort.every2h', '2h'),
  'twice-daily': () => translate('bots.settingsView.lookAroundShort.twiceDaily', 'Twice a day'),
  mornings: () => translate('bots.settingsView.lookAroundShort.mornings', 'Mornings')
}

/** "4h"; null while it is off, as its switch says. */
export function lookAroundValue(setting: BotLookAround): string | null {
  return setting.on ? LOOK_AROUND_SHORT[setting.every]() : null
}

/** "Nightly" or "Weekly"; null while it is off, as its switch says. */
export function tidyUpValue(setting: BotTidyUp): string | null {
  if (!setting.on) {
    return null
  }
  return setting.every === 'night'
    ? translate('bots.settingsView.tidyUpShort.night', 'Nightly')
    : translate('bots.settingsView.tidyUpShort.week', 'Weekly')
}

/** A count, or "None". */
export function countValue(count: number): string {
  return count > 0 ? String(count) : none()
}

/** "Sentry, Playwright · 6 more from Claude Code"; null until the tools are read. */
export function toolsLine(
  tools: BotTools | null,
  agentLabel: string,
  intlLocale?: string
): string | null {
  return botToolsLine(tools, {
    none: none(),
    from: (count) =>
      translate('bots.settingsPage.toolsFrom', '{{count}} from {{agent}}', {
        count,
        agent: agentLabel
      }),
    more: (count) =>
      translate('bots.settingsPage.toolsMore', '{{count}} more from {{agent}}', {
        count,
        agent: agentLabel
      }),
    list: (names) => nameList(names, intlLocale)
  })
}

/** Names, or "None". */
export function namesLine(names: readonly string[], intlLocale?: string): string {
  return names.length > 0 ? nameList(names, intlLocale) : none()
}

/** "Only you", "You and 4 others", "You and 4 others · 1 request". */
export function whoCanAskValue(people: number, requests: number): string {
  const who =
    people > 0
      ? translate('bots.settingsView.youAndOthers', 'You and {{count}} others', {
          count: people,
          defaultValue_one: 'You and {{count}} other'
        })
      : translate('bots.settingsPage.onlyYou', 'Only you')
  return requests > 0
    ? `${who} · ${translate('settings.bots.connectorRequests', '{{count}} requests', {
        count: requests,
        defaultValue_one: '{{count}} request'
      })}`
    : who
}
