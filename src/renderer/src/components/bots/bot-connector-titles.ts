import { translate } from '@/i18n/i18n'
import {
  botConnectorTitleLine,
  type BotConnectorTitle
} from '../../../../shared/bots/bot-connector-titles'

export type { BotConnectorTitle } from '../../../../shared/bots/bot-connector-titles'

/** The text between service and name, also drawn as the end of the service part. */
export function botConnectorTitleSeparator(): string {
  return translate('bots.connector.titleSeparator', ' · ')
}

export function botConnectorTitleText(title: BotConnectorTitle): string {
  return botConnectorTitleLine(title, botConnectorTitleSeparator())
}
