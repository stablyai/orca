// A stable machine-readable key for the free-text SSH error, so triage keeps a
// bucket even after `scrubDiagnosticText` eats the hostname the message names.
//
// Why a local copy of the fragment tables rather than importing
// `src/main/ssh/ssh-reconnect-error-classification.ts`: that module exposes
// only booleans (no category), and it is not in `config/tsconfig.tc.web.json`'s
// include list — it reaches `ssh-connection-utils` and from there the `ssh2`
// graph, so importing it would mean widening the web program.

export type SshErrorCategory =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'unreachable'
  | 'reset'
  | 'auth'
  | 'passphrase'
  | 'host-key'
  | 'key-file'
  | 'relay'
  | 'other'

// First match wins, so the specific buckets precede the general ones.
const CATEGORY_FRAGMENTS: { category: SshErrorCategory; fragments: string[] }[] = [
  {
    category: 'dns',
    fragments: [
      'enotfound',
      'eai_again',
      'could not resolve hostname',
      'nodename nor servname',
      'name or service not known',
      'temporary failure in name resolution'
    ]
  },
  { category: 'passphrase', fragments: ['passphrase', 'encrypted key', 'bad decrypt'] },
  {
    category: 'host-key',
    fragments: [
      'host key verification failed',
      'remote host identification has changed',
      'known_hosts',
      'host key for',
      'no matching host key type'
    ]
  },
  {
    category: 'auth',
    // NOT a bare `permission denied`: the product's own `isAuthError`
    // (ssh-connection-utils.ts) deliberately requires the method suffix, because a
    // remote `EACCES`/`mkdir`/relay-install denial is a filesystem fault, not a
    // credential one — and it is classified `error`, not `auth-failed`, upstream.
    // Bare `publickey` is gone for the same reason: it appears in the benign
    // `Authentications that can continue: publickey,password` line of an error
    // whose actual cause is on a later line.
    fragments: [
      'permission denied, please try again',
      'permission denied (',
      'authentication failed',
      'all configured authentication methods failed',
      'too many authentication failures'
    ]
  },
  { category: 'refused', fragments: ['econnrefused', 'connection refused'] },
  {
    category: 'unreachable',
    fragments: [
      'ehostunreach',
      'enetunreach',
      'no route to host',
      'network is unreachable',
      'network is down',
      'host is down'
    ]
  },
  {
    category: 'timeout',
    fragments: ['etimedout', 'timed out', 'operation timed out', 'timeout']
  },
  {
    category: 'reset',
    fragments: [
      'econnreset',
      'epipe',
      'connection reset',
      'broken pipe',
      'lost connection',
      'remote end closed',
      'connection closed by remote',
      'kex_exchange_identification',
      'ssh_exchange_identification'
    ]
  },
  // `no such file` is gone: it is generic (`ENOENT … open '/tmp/orca-relay.tgz'`)
  // while the bucket is specific, so it pointed relay-packaging faults at the
  // user's key material. `are too open` / `unprotected` is what OpenSSH actually
  // prints for a bad key mode — the bucket was missing its likeliest input.
  {
    category: 'key-file',
    fragments: [
      'bad permissions',
      'are too open',
      'unprotected private key',
      'load key',
      'key_load_public'
    ]
  },
  { category: 'relay', fragments: ['relay'] }
]

// The whole message is often an aggregate — `ssh-connection.ts:941` splices entire
// system-ssh stderr into one string — so first-match-wins over the aggregate returns
// whichever bucket sits highest in the table, not the failure that actually ended the
// connect. Scanning last line first makes the terminal cause win; the whole string is
// still the fallback so single-line and wrapped messages are unaffected.
function categoryOfLine(line: string): SshErrorCategory | null {
  const message = line.toLowerCase()
  for (const { category, fragments } of CATEGORY_FRAGMENTS) {
    if (fragments.some((fragment) => message.includes(fragment))) {
      return category
    }
  }
  return null
}

/** Classify from the RAW error, before scrubbing — redaction must not move the bucket. */
export function classifySshErrorCategory(error: unknown): SshErrorCategory | null {
  if (typeof error !== 'string' || error.length === 0) {
    return null
  }
  const lines = error.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const category = categoryOfLine(lines[index] ?? '')
    if (category) {
      return category
    }
  }
  return categoryOfLine(error) ?? 'other'
}
