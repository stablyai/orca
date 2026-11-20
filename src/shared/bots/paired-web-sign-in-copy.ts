import { CONNECTOR_OFFER_NAMES, type OfferSource } from './bot-connector-offer'

/** A paired web window names its server and how to sign that server in. */
export function pairedWebServerSignInLine(host: string): string {
  return `On ${host}, run \`orca auth login\`.`
}

/** The connectors notice when that server is signed out. */
export function pairedWebSignedOutNotice(host: string): string {
  return `${host} is signed out of Orca. ${pairedWebServerSignInLine(host)}`
}

/** A chat Connect card's sign-in line for that server. */
export function pairedWebChatSignInLine(
  source: OfferSource,
  host: string,
  botName: string
): string {
  const what = source === 'webhook' ? 'Webhooks' : `${CONNECTOR_OFFER_NAMES[source]} events`
  return `${what} need Orca sign-in. On ${host}, run \`orca auth login\`, then tell ${botName}.`
}
