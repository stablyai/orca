import { stripCredentialsFromMessage } from './git-remote-error'

// Why: clones run under nonInteractiveGitEnv (GIT_TERMINAL_PROMPT=0, empty SSH_ASKPASS,
// `ssh -o BatchMode=yes`) so a background clone cannot hang on a prompt nobody sees. The cost is
// that git's own SSH errors read identically to an ordinary permission problem, and on a remote
// or paired-runtime clone the user is looking at their own working local `git clone` while Orca
// fails — with nothing in the message saying the clone ran somewhere else, without their agent.
const CLONE_HOST_NOTE =
  'The clone runs non-interactively (BatchMode=yes) on the machine that will hold the repository, using the SSH keys and agent on that machine rather than the ones on this computer.'
const CLONE_KEY_HINT = `${CLONE_HOST_NOTE} A passphrase-protected key cannot prompt there, so load it into an agent on that machine (ssh-add) and retry.`
const CLONE_HOST_KEY_HINT = `${CLONE_HOST_NOTE} It has not trusted this host key yet — connect once from a shell on that machine to record it in its known_hosts.`

/** An ssh(1) diagnostic, i.e. a line only the SSH transport can have produced. */
const SSH_TRANSPORT_DIAGNOSTIC =
  /\bssh|permission denied \(|connection (?:closed|reset|refused|timed out) by/i

export function getGitCloneFailureMessage(
  stderr: string,
  options: { clonePath?: string | null } = {}
): string {
  return appendCloneTransportGuidance(
    getGitCloneFailureLine(stderr, options),
    stripCredentialsFromMessage(stderr)
  )
}

/** Guidance the raw git error omits: where the clone ran, and why nothing could prompt there. */
function appendCloneTransportGuidance(message: string, scrubbedStderr: string): string {
  // Re-entrant: remote-repo-clone re-parses a message the relay already built.
  if (message.includes(CLONE_HOST_NOTE)) {
    return message
  }
  if (/host key verification failed/i.test(scrubbedStderr)) {
    return `${message} ${CLONE_HOST_KEY_HINT}`
  }
  if (/permission denied \(([^)]*publickey[^)]*)\)/i.test(scrubbedStderr)) {
    return `${message} ${CLONE_KEY_HINT}`
  }
  // Every other SSH-transport failure still needs the one fact the reporter was missing — but only
  // once something proves the transport was SSH: git prints this same line for the HTTP remote
  // helper, where a note about keys and agents is simply wrong.
  return /could not read from remote repository/i.test(scrubbedStderr) &&
    SSH_TRANSPORT_DIAGNOSTIC.test(scrubbedStderr)
    ? `${message} ${CLONE_HOST_NOTE}`
    : message
}

function getGitCloneFailureLine(
  stderr: string,
  options: { clonePath?: string | null } = {}
): string {
  let fallbackLine: string | null = null

  // Why: clone errors echo the URL the user typed, which is the most likely
  // git error to embed a live token (`https://user:ghp_…@host/repo.git`).
  // Scrub up-front so every return branch operates on already-redacted text,
  // matching normalizeGitErrorMessage.
  const scrubbedStderr = stripCredentialsFromMessage(stderr)

  for (const rawLine of iterateLinesFromEnd(scrubbedStderr)) {
    const line = stripAnsi(rawLine).trim()
    if (!line) {
      continue
    }
    fallbackLine ??= line
    const fatalIndex = line.indexOf('fatal:')
    if (fatalIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(fatalIndex), options)
    }
    const errorIndex = line.indexOf('error:')
    if (errorIndex !== -1) {
      return formatGitCloneFailureLine(line.slice(errorIndex), options)
    }
  }

  return formatGitCloneFailureLine(fallbackLine ?? 'unknown error', options)
}

function* iterateLinesFromEnd(value: string): Generator<string> {
  let lineEnd = value.length
  let index = value.length - 1

  while (index >= 0) {
    const code = value.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      index--
      continue
    }

    const delimiterStart =
      code === 10 && index > 0 && value.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield value.slice(index + 1, lineEnd)
    lineEnd = delimiterStart
    index = delimiterStart - 1
  }

  yield value.slice(0, lineEnd)
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
}

function formatGitCloneFailureLine(line: string, options: { clonePath?: string | null }): string {
  const destinationMatch = line.match(
    /^fatal:\s+destination path '([^']+)' already exists and is not an empty directory\.$/
  )
  if (destinationMatch || /repository exists/i.test(line)) {
    const destination = options.clonePath?.trim() || destinationMatch?.[1] || null
    const target = destination ? `: ${destination}` : ''
    return `Destination already exists and is not empty${target}. Choose a different parent folder, delete the existing folder, or add the existing repository instead.`
  }
  return line
}
