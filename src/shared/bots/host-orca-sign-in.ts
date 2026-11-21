// How a bot's host that isn't signed in to Orca Cloud reads, and how it signs in. A headless Orca server has
// no Settings of its own: it signs in with `orca auth login` there, or from the bot's Connectors tab
// in Orca on the owner's computer, which runs the same sign-in on the server.

/**
 * Whether a host's link to Orca Cloud waits on its Orca sign-in: signed out, or signed in with a sign-in
 * Orca Cloud refuses (`needs-sign-in`). Either way nothing reaches its bots until it signs in again.
 */
export function orcaCloudNeedsSignIn(status: string | null | undefined): boolean {
  return status === 'signed-out' || status === 'needs-sign-in'
}

/** The headless Orca server's hostname, as `orca auth login` and its approval page name it; null on a
 *  computer with Orca's window, which signs in from its own Settings; undefined when an older host
 *  didn't say which it is. */
export type OrcaSignInServer = string | null | undefined

/** "This computer" or "This Orca server (box1)". */
export function thisHost(server: OrcaSignInServer): string {
  return server ? `This Orca server (${server})` : 'This computer'
}

/** "This computer isn't signed in to Orca Cloud" (signed out, or a sign-in Orca Cloud refuses), or
 *  "This Orca server (box1) isn't signed in to Orca Cloud". */
export function hostNotSignedIn(server: OrcaSignInServer): string {
  return `${thisHost(server)} isn't signed in to Orca Cloud`
}

/**
 * How a headless server signs in, for the bot to relay (`bot`) or for its owner to read (`owner`);
 * null on a computer with Orca's window. Only the owner signs in: whoever approves picks the account.
 */
export function serverSignInSteps(
  server: OrcaSignInServer,
  botName: string,
  reader: 'bot' | 'owner'
): string | null {
  if (!server) {
    return null
  }
  // A sign-in Orca Cloud refuses is still signed in on the server, where only --switch starts again.
  const command = `\`orca auth login\` in a terminal on ${server} (\`orca auth login --switch\` if it says the server is already signed in)`
  return reader === 'bot'
    ? `Your owner can sign it in by running ${command}, or with Sign in on ${botName}'s Connectors tab in Orca on their computer.`
    : `Run ${command}, or use Sign in on ${botName}'s Connectors tab in Orca on your computer.`
}

/** For a host that didn't say whether it has a window (an older one): how it signs in if it has none. */
export function unknownHostSignInHint(server: OrcaSignInServer): string | null {
  return server === undefined
    ? 'On a server with no Orca window, `orca auth login` on it signs it in.'
    : null
}

/** `text`, then how a headless server signs in when the host is one. */
export function withServerSignInSteps(
  text: string,
  server: OrcaSignInServer,
  botName: string,
  reader: 'bot' | 'owner'
): string {
  const steps = serverSignInSteps(server, botName, reader)
  return steps ? `${text} ${steps}` : text
}
