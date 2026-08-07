import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SshConnectionState, SshProviderEpoch } from '../../../shared/ssh-types'
import {
  buildSshDiagnosticReport,
  MAX_FREE_TEXT_CHARS,
  MAX_SCRUB_INPUT_CHARS,
  redactPaths,
  resetSshDiagnosticAppVersionForTests,
  scrubDiagnosticText
} from './ssh-diagnostic-report'
import {
  forgetSshStatusTimeline,
  recordSshStateArrival,
  snapshotSshStatusTimeline
} from './ssh-status-timeline'

const TARGET_ID = 'ssh-1754000000000-abcdef'
const ENVIRONMENT_ID = 'env-1'

function makeState(overrides: Partial<SshConnectionState> = {}): SshConnectionState {
  return {
    targetId: TARGET_ID,
    status: 'reconnecting',
    error: null,
    reconnectAttempt: 3,
    ...overrides
  }
}

function setLocalState(state: SshConnectionState): void {
  useAppStore.setState({ sshConnectionStates: new Map([[TARGET_ID, state]]) })
}

function setEnvironmentState(state: SshConnectionState): void {
  useAppStore.setState({
    sshStateByEnvironment: new Map([
      [
        ENVIRONMENT_ID,
        {
          connectionStates: new Map([[TARGET_ID, state]]),
          targetLabels: new Map<string, string>(),
          removedTargetLabels: new Map<string, string>(),
          targetsHydrated: true
        }
      ]
    ])
  })
}

function build(overrides: Partial<Parameters<typeof buildSshDiagnosticReport>[0]> = {}) {
  return buildSshDiagnosticReport({
    targetId: TARGET_ID,
    targetRemoved: false,
    environmentId: null,
    ...overrides
  })
}

beforeEach(() => {
  resetSshDiagnosticAppVersionForTests()
  forgetSshStatusTimeline(TARGET_ID)
  forgetSshStatusTimeline(TARGET_ID, ENVIRONMENT_ID)
  useAppStore.setState({
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    sshStateByEnvironment: new Map()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  forgetSshStatusTimeline(TARGET_ID)
  forgetSshStatusTimeline(TARGET_ID, ENVIRONMENT_ID)
})

describe('buildSshDiagnosticReport sections', () => {
  it('reads live state for a local target', () => {
    setLocalState(
      makeState({
        status: 'reconnection-failed',
        error: 'Relay channel lost. Reconnecting...',
        reconnectAttempt: 6,
        connectionGeneration: 12,
        remotePlatform: 'linux',
        supportsFolderDownload: true
      })
    )

    const report = build()

    expect(report.live).toEqual({
      status: 'reconnection-failed',
      liveStatePresent: true,
      error: 'Relay channel lost. Reconnecting...',
      errorCategory: 'relay',
      reconnectAttempt: 6,
      connectionGeneration: 12,
      remotePlatform: 'linux',
      supportsFolderDownload: true,
      targetRemoved: false,
      runtimeOwned: false
    })
    expect(report.sectionErrors).toEqual({})
  })

  it('reads live state from the environment bucket for a runtime-owned target', () => {
    setLocalState(makeState({ status: 'connected' }))
    setEnvironmentState(makeState({ status: 'auth-failed', reconnectAttempt: 1 }))

    const report = build({ environmentId: ENVIRONMENT_ID })

    expect(report.live.status).toBe('auth-failed')
    expect(report.live.reconnectAttempt).toBe(1)
    expect(report.live.runtimeOwned).toBe(true)
  })

  it('carries the recorded timeline', () => {
    recordSshStateArrival(
      TARGET_ID,
      makeState({ status: 'connected', reconnectAttempt: 0 }),
      'push'
    )
    recordSshStateArrival(TARGET_ID, makeState({ status: 'reconnecting' }), 'runtime-hydration')

    const report = build()

    expect(report.timeline.map((entry) => entry.status)).toEqual(['connected', 'reconnecting'])
    expect(report.timeline[1]?.attempt).toBe(3)
    expect(report.timeline[1]?.origin).toBe('runtime-hydration')
  })

  it('reads a runtime-owned timeline from its own environment scope', () => {
    setEnvironmentState(makeState({ status: 'reconnecting' }))
    recordSshStateArrival(TARGET_ID, makeState({ status: 'error' }), 'push', ENVIRONMENT_ID)
    recordSshStateArrival(TARGET_ID, makeState({ status: 'reconnecting' }), 'push', ENVIRONMENT_ID)

    // Dropping the environment id here silently empties the timeline for exactly
    // the paired/remote case the report exists for — the rings are scoped by
    // `${environmentId ?? 'local'}::${targetId}`.
    expect(build({ environmentId: ENVIRONMENT_ID }).timeline.map((entry) => entry.status)).toEqual([
      'error',
      'reconnecting'
    ])
    expect(build().timeline).toEqual([])
  })

  it('builds with an empty timeline', () => {
    setLocalState(makeState())

    const report = build()

    expect(report.timeline).toEqual([])
    expect(report.sectionErrors).toEqual({})
  })

  it('classifies the raw error into a stable category the scrub cannot move', () => {
    setLocalState(makeState({ error: 'getaddrinfo ENOTFOUND bastion.corp.acme.com' }))

    const report = build()

    expect(report.live.errorCategory).toBe('dns')
    expect(report.live.error).toBe('getaddrinfo ENOTFOUND <host>')
  })

  it('reports the client platform from the preload, not the user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    vi.stubGlobal('window', { api: { platform: { get: () => ({ platform: 'linux' }) } } })

    expect(build().clientPlatform).toBe('linux')
  })

  it('falls back to the user agent when no preload platform is available', () => {
    vi.stubGlobal('window', {})

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
    expect(build().clientPlatform).toBe('darwin')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(build().clientPlatform).toBe('win32')

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(build().clientPlatform).toBe('linux')
  })

  it('stamps a distinct short capture id and an ISO capture time', () => {
    const first = build()
    const second = build()

    expect(first.captureId).toMatch(/^[a-z0-9]{8}$/)
    expect(first.captureId).not.toBe(second.captureId)
    expect(new Date(first.capturedAt).toISOString()).toBe(first.capturedAt)
  })
})

describe('buildSshDiagnosticReport live-state presence', () => {
  it('defaults a store-less target to the status the overlay shows, and says it defaulted', () => {
    const report = buildSshDiagnosticReport({
      targetId: 'ssh-never-seen',
      targetRemoved: true,
      environmentId: null
    })

    // Mirrors `selectRuntimeAwareSshStatus`'s `?? 'disconnected'` fallback.
    expect(report.live.status).toBe('disconnected')
    expect(report.live.liveStatePresent).toBe(false)
    expect(report.sectionErrors).toEqual({})
  })

  it('marks a present state as present', () => {
    setLocalState(makeState())

    expect(build().live.liveStatePresent).toBe(true)
  })
})

describe('buildSshDiagnosticReport failure containment', () => {
  it('records a section error instead of throwing when the store throws', () => {
    vi.spyOn(useAppStore, 'getState').mockImplementation(() => {
      throw new Error('store exploded')
    })

    const report = build()

    expect(report.sectionErrors.live).toContain('store exploded')
    expect(report.live).toEqual({
      // A throwing store is not evidence of `disconnected`, so the status stays unknown.
      status: null,
      liveStatePresent: false,
      error: null,
      errorCategory: null,
      reconnectAttempt: null,
      connectionGeneration: null,
      remotePlatform: null,
      supportsFolderDownload: null,
      targetRemoved: false,
      runtimeOwned: false
    })
    expect(report.timeline).toEqual([])
  })

  it('does not throw for an unknown target id', () => {
    setLocalState(makeState())

    const report = buildSshDiagnosticReport({
      targetId: 'ssh-never-seen',
      targetRemoved: true,
      environmentId: null
    })

    expect(report.live.liveStatePresent).toBe(false)
    expect(report.live.targetRemoved).toBe(true)
    expect(report.timeline).toEqual([])
  })

  it('does not throw for an environment id with no bucket', () => {
    const report = build({ environmentId: 'env-never-seen' })

    expect(report.live.liveStatePresent).toBe(false)
    expect(report.live.runtimeOwned).toBe(true)
    expect(report.sectionErrors).toEqual({})
  })

  it('scrubs section errors with the same pass as live errors', () => {
    vi.spyOn(useAppStore, 'getState').mockImplementation(() => {
      throw new Error('boom at file:///Users/jinjing/Documents/orca/renderer.js:12')
    })

    const report = build()

    expect(report.sectionErrors.live).not.toContain('jinjing')
    expect(report.sectionErrors.live).not.toContain('/Users/')
    expect(report.sectionErrors.live).toContain('<path>')
  })

  it('keeps a Windows CRLF out of the recorded section error', () => {
    vi.spyOn(useAppStore, 'getState').mockImplementation(() => {
      throw new Error('store exploded\r\nssh_exchange_identification')
    })

    const report = build()

    expect(report.sectionErrors.live).toBe('Error: store exploded')
    expect(report.sectionErrors.live).not.toContain('\r')
  })
})

describe('buildSshDiagnosticReport appVersion', () => {
  it('is null and touches no IPC when the cache has not primed', () => {
    setLocalState(makeState())
    // `platform.get()` is a synchronous preload read (`process.platform`), not a
    // round-trip, so only the async surfaces are trapped.
    const apiTrap = new Proxy(
      { platform: { get: () => ({ platform: 'darwin' }) } },
      {
        get(target, property) {
          if (property === 'platform') {
            return Reflect.get(target, property)
          }
          throw new Error('assembly must not touch window.api')
        }
      }
    )
    vi.stubGlobal('window', { api: apiTrap })

    const report = build()

    expect(report.appVersion).toBeNull()
    expect(report.sectionErrors).toEqual({})
  })
})

describe('scrubDiagnosticText', () => {
  it('removes provider keys, JWTs, and every path flavour', () => {
    const raw = [
      'auth failed with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'identity /Users/jinjing/.ssh/id_ed25519',
      'fallback C:\\Users\\jinjing\\.ssh\\id_rsa',
      'share \\\\fileserver\\keys\\id_rsa',
      'home ~/Documents/projects/orca'
    ].join('\n')

    const scrubbed = scrubDiagnosticText(raw)

    expect(scrubbed).not.toContain('sk-ant-')
    expect(scrubbed).not.toContain('eyJhbGci')
    expect(scrubbed).not.toContain('jinjing')
    expect(scrubbed).not.toContain('fileserver')
    expect(scrubbed).not.toContain('Documents')
    expect(scrubbed).toContain('[redacted:anthropic-key]')
    expect(scrubbed).toContain('[redacted:jwt]')
    expect(scrubbed).toContain('<path>')
  })

  it('redacts a PEM block longer than the truncation cap whole', () => {
    const body = 'A'.repeat(900)
    const scrubbed = scrubDiagnosticText(
      `key load failed\n-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`
    )

    expect(scrubbed).not.toContain('AAAA')
    expect(scrubbed).not.toContain('-----BEGIN')
    expect(scrubbed).toContain('[redacted:pem]')
  })

  it('caps at MAX_FREE_TEXT_CHARS after redacting', () => {
    const scrubbed = scrubDiagnosticText('x'.repeat(4096))

    expect(scrubbed.length).toBe(MAX_FREE_TEXT_CHARS)
    expect(scrubbed.endsWith('…')).toBe(true)
  })

  it('never truncates into a lone surrogate', () => {
    const scrubbed = scrubDiagnosticText(`${'a'.repeat(510)}😀${'b'.repeat(64)}`)

    expect(scrubbed.isWellFormed()).toBe(true)
    expect(JSON.stringify(scrubbed)).not.toContain('\\ud83d')
  })

  it('leaves prose slashes, ratios, and dates alone', () => {
    expect(scrubDiagnosticText('connect and/or retry 1/2')).toBe('connect and/or retry 1/2')
    expect(scrubDiagnosticText('ratio 1/2/3 exceeded')).toBe('ratio 1/2/3 exceeded')
    expect(scrubDiagnosticText('2026/08/04 12:00 connect failed')).toBe(
      '2026/08/04 12:00 connect failed'
    )
  })

  it('splits a URL into its scheme, host, and path instead of mangling it', () => {
    expect(scrubDiagnosticText('https://gitlab.internal.acme.com/team/repo.git unreachable')).toBe(
      'https://<host><path> unreachable'
    )
    expect(scrubDiagnosticText('ssh://git@gitlab.acme.com:2222/team/repo.git')).toBe(
      'ssh://<user>@<host><path>'
    )
  })

  it('keeps the diagnostic grammar of the error it redacts', () => {
    expect(scrubDiagnosticText('connect ECONNREFUSED 10.1.2.3:22')).toBe(
      'connect ECONNREFUSED <ip>:22'
    )
    expect(scrubDiagnosticText('Host key verification failed.')).toBe(
      'Host key verification failed.'
    )
  })

  // The prose carriers, one per OpenSSH sentence that names a dotless host.
  // A single `host`/`hostname`-anchored rule needed a digit/dot/hyphen lookahead
  // to spare `Host key verification failed`, and that lookahead let every one of
  // these through.
  it.each([
    [
      'ssh: Could not resolve hostname bastion: Name or service not known',
      'ssh: Could not resolve hostname <host>: Name or service not known'
    ],
    [
      'ssh: connect to host devbox port 22: Connection refused',
      'ssh: connect to host <host> port 22: Connection refused'
    ],
    ['getaddrinfo ENOTFOUND buildbox', 'getaddrinfo ENOTFOUND <host>'],
    ['Connection closed by nas port 22', 'Connection closed by <host> port 22'],
    [
      "Warning: Permanently added 'prod-db-01' (ED25519) to the list of known hosts.",
      'Warning: Permanently added <host> (ED25519) to the list of known hosts.'
    ],
    [
      'Host key for prod-db-01 has changed and you have requested strict checking.',
      'Host key for <host> has changed and you have requested strict checking.'
    ],
    ['Could not resolve hostname 例え.テスト: nope', 'Could not resolve hostname <host>: nope'],
    [
      'Connection closed by authenticating user root 10.0.0.5 port 22',
      'Connection closed by authenticating user <user> <ip> port 22'
    ],
    // OpenSSH verbose client lines name the host without the word "host".
    [
      'Authenticated to bastion ([10.0.0.1]:22) using "publickey".',
      'Authenticated to <host> ([<ip>]:22) using "publickey".'
    ],
    ['Connecting to bastion [10.0.0.1] port 22.', 'Connecting to <host> [<ip>] port 22.'],
    // sshd account carriers beyond "authenticating/invalid user".
    ['Disconnected from user alice 10.0.0.1 port 22', 'Disconnected from user <user> <ip> port 22'],
    [
      'Failed password for alice from 10.0.0.1 port 22 ssh2',
      'Failed password for <user> from <ip> port 22 ssh2'
    ],
    [
      'Accepted publickey for alice from 10.0.0.1 port 22 ssh2',
      'Accepted publickey for <user> from <ip> port 22 ssh2'
    ],
    // Quoted single-label forms — bare HOST_LABEL left these intact.
    [
      "ssh: Could not resolve hostname 'mybox': Name or service not known",
      'ssh: Could not resolve hostname <host>: Name or service not known'
    ],
    ['getaddrinfo ENOTFOUND "buildbox"', 'getaddrinfo ENOTFOUND <host>'],
    [
      "ssh: connect to host 'devbox' port 22: Connection refused",
      'ssh: connect to host <host> port 22: Connection refused'
    ],
    ["Invalid user 'alice' from 10.0.0.1 port 22", 'Invalid user <user> from <ip> port 22'],
    // A hyphenated host that opens on a stop word is still a host.
    [
      'ssh: connect to host a-host port 22: Connection refused',
      'ssh: connect to host <host> port 22: Connection refused'
    ],
    // The generic prose that names no host stays whole.
    ['Host key verification failed.', 'Host key verification failed.'],
    [
      'ssh_exchange_identification: read: Connection reset by peer',
      'ssh_exchange_identification: read: Connection reset by peer'
    ],
    ['REMOTE HOST IDENTIFICATION HAS CHANGED!', 'REMOTE HOST IDENTIFICATION HAS CHANGED!'],
    ['No route to host', 'No route to host'],
    [
      'kex_exchange_identification: Connection closed by remote host 198.51.100.4 port 22',
      'kex_exchange_identification: Connection closed by remote host <ip> port 22'
    ]
  ])('names no dotless host: %s', (raw, expected) => {
    expect(scrubDiagnosticText(raw)).toBe(expected)
  })

  // A path rule whose terminal segment stops at the first space republishes the
  // name it was there to remove, in the tail it leaves behind.
  it.each([
    ['no such file or directory: /Users/John Smith', 'no such file or directory: <path>'],
    ['scp: /Volumes/Tim Backup: No such file', 'scp: <path>: No such file'],
    // Not `Users` / `Documents and Settings`: a corporate mapped home drive.
    ['Load key E:\\Home Dirs\\jsmith\\.ssh\\id_rsa: bad perms', 'Load key <path>: bad perms'],
    ['cannot open .\\keys\\Jane Smith\\id_rsa', 'cannot open <path>'],
    // Finished path + English prose must not collapse into one `<path>` span —
    // the diagnosis after the path is what the user is reporting.
    [
      'Add correct host key in /Users/alice/.ssh/known_hosts to get rid of this message.',
      'Add correct host key in <path> to get rid of this message.'
    ]
  ])('takes the whole spaced path: %s', (raw, expected) => {
    expect(scrubDiagnosticText(raw)).toBe(expected)
  })

  // The FQDN rule is deliberately greedy, but a dotted token that is the entire
  // diagnosis is not a host — `Request "<host>" timed out` is unfileable.
  it.each([
    'Request "pty.open" timed out after 15000ms',
    'Request "git.exec" timed out after 15000ms',
    'at ssh-connection.ts:1321',
    'Failed to load config.json',
    'Error: boom\n    at SshChannelMultiplexer.request (ssh-channel-multiplexer.ts:56:31)'
  ])('keeps the dotted token that is the diagnosis: %s', (raw) => {
    expect(scrubDiagnosticText(raw)).toBe(raw)
  })

  // The exemptions key on the template, never on the token — a host reads the
  // same as an RPC method on its own. Quoted FQDNs are eaten whole (quotes
  // included) by the hostname carrier, same as Permanently added.
  it.each([
    [`Could not resolve hostname 'db.internal'`, 'Could not resolve hostname <host>'],
    [
      'connect failed at gitlab.acme.com (retry pending)',
      'connect failed at <host> (retry pending)'
    ]
  ])('still eats a dotted host outside those templates: %s', (raw, expected) => {
    expect(scrubDiagnosticText(raw)).toBe(expected)
  })

  // Live `state.error` is not record-capped; scrub must bound the regex input
  // itself so a multi-100KB system-SSH stderr cannot stall the copy click.
  // Asserted on the dropped span rather than on elapsed time: a shared runner's
  // wall clock fails without a regression, and passes with one on a fast box.
  it('bounds regex work to MAX_SCRUB_INPUT_CHARS before redacting', () => {
    const secretTail = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    // The head is one collapsible path, so redaction shrinks it to `<path>` and
    // an unbounded pass would pull `middle-only` into the 512-char output. Only
    // the input bound — which keeps the head and tail and drops the middle —
    // can keep it out.
    const raw = `/Users/alice/${'a'.repeat(MAX_SCRUB_INPUT_CHARS)} middle-only ${'z'.repeat(2_000)} ${secretTail}`
    const scrubbed = scrubDiagnosticText(raw)

    expect(scrubbed.length).toBe(MAX_FREE_TEXT_CHARS)
    expect(scrubbed).not.toContain('middle-only')
    expect(scrubbed).not.toContain('sk-ant-')
    expect(scrubbed).not.toContain(secretTail)
  })

  it('is idempotent', () => {
    const raw =
      'ssh /var/folders/tmp/orca.sock and C:\\Users\\me\\app and \\\\host\\share\\x and ~/bin/ssh'
    const once = redactPaths(raw)

    expect(redactPaths(once)).toBe(once)
    expect(scrubDiagnosticText(once)).toBe(once)
  })

  it('is idempotent over every identifier shape', () => {
    for (const raw of [
      'jane.doe@bastion.corp.acme.com: Permission denied (publickey).',
      'kex_exchange_identification: Connection closed by remote host 198.51.100.4 port 22',
      'SHA256:9qF3xW1kZ0pQvT8mN2bR7yL4cH6sJ5dG1aE0uI3oK8w.',
      'ssh: Could not resolve hostname prod-db-01: nodename nor servname provided',
      'https://gitlab.internal.acme.com/team/repo.git',
      'Connection to prod-bastion is already in progress',
      'getaddrinfo ENOTFOUND buildbox',
      'getaddrinfo ENOTFOUND "buildbox"',
      "ssh: Could not resolve hostname 'mybox': Name or service not known",
      'Connection closed by nas port 22',
      "Warning: Permanently added 'prod-db-01' (ED25519) to the list of known hosts.",
      'Host key for prod-db-01 has changed and you have requested strict checking.',
      'Authenticated to bastion ([10.0.0.1]:22) using "publickey".',
      'Failed password for alice from 10.0.0.1 port 22 ssh2',
      'no such file or directory: /Users/John Smith',
      'Load key E:\\Home Dirs\\jsmith\\.ssh\\id_rsa: bad perms',
      'cannot open .\\keys\\Jane Smith\\id_rsa',
      'Request "pty.open" timed out after 15000ms'
    ]) {
      const once = scrubDiagnosticText(raw)

      expect(scrubDiagnosticText(once)).toBe(once)
    }
  })
})

// §7 promises host, IP, config alias, label, username, target id, identity
// strings and host-key fingerprint are dropped entirely. These fixtures carry
// real ones — the previous version of this suite asserted against values the
// report type has no field for, so it could not fail.
// Every unquoted and single-label shape here leaked past the previous suite,
// which only carried the two fixtures that happen to redact: the *quoted*
// Windows path and a hostname named by the one prose phrase the rule anchored
// on. Curated fixtures are why B1/B2 survived review — keep the awkward ones.
const IDENTIFYING_ERROR = [
  'jane.doe@bastion.corp.acme.com: Permission denied (publickey).',
  'connect ECONNREFUSED 10.1.2.3:22',
  'Server host key: SHA256:9qF3xW1kZ0pQvT8mN2bR7yL4cH6sJ5dG1aE0uI3oK8w',
  'Load key "C:\\Users\\John Smith\\.ssh\\id_ed25519": bad permissions',
  'Load key ~jane.doe/.ssh/config: bad permissions',
  'Connection to prod-bastion is already in progress'
].join('\n')

// Split from the block above only to stay under the 512-char capture cap: the
// assertions below scrub each on its own.
const IDENTIFYING_ERROR_UNQUOTED = [
  'ssh: Could not resolve hostname mybox: Name or service not known',
  'getaddrinfo ENOTFOUND buildbox',
  'no such file or directory: /Users/John Smith',
  'Load key E:\\Home Dirs\\jsmith\\.ssh\\id_rsa: bad permissions',
  'cannot open .\\keys\\Jane Smith\\id_rsa',
  "Warning: Permanently added 'prod-db-01' (ED25519) to the list of known hosts.",
  'Connection closed by nas port 22'
].join('\n')

const IDENTIFIERS = [
  'bastion.corp.acme.com',
  'acme.com',
  'jane.doe',
  '10.1.2.3',
  '9qF3xW1kZ0pQ',
  'John',
  'Smith',
  'id_ed25519',
  'prod-bastion',
  'C:\\Users'
]

const UNQUOTED_IDENTIFIERS = [
  'mybox',
  'buildbox',
  'John',
  'Smith',
  'Jane',
  'jsmith',
  'Home Dirs',
  'E:\\',
  'prod-db-01',
  'nas'
]

// §7 promises usernames are dropped, and this payload is written to be pasted into
// a public tracker. Two whole shapes used to survive it: the Windows `DOMAIN\user`
// account form, and every `for <user>` sentence outside the four that were listed.
describe('scrubDiagnosticText account names', () => {
  it.each([
    // The domain used to absorb the placeholder, republishing the account after it.
    [String.raw`Connection closed by authenticating user CONTOSO\alice 10.0.0.5 port 22`],
    [String.raw`Invalid user CONTOSO\alice from 10.0.0.1 port 22`],
    [String.raw`Failed password for CONTOSO\alice from 10.0.0.1 port 22`],
    [String.raw`Disconnected from user CONTOSO\alice 10.0.0.1 port 22`],
    // The agent-offers-too-many-keys failure — the commonest of the lot.
    ['Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures for alice'],
    ['Failed publickey for alice from 10.0.0.5 port 22'],
    ['Failed keyboard-interactive for alice from 10.0.0.5 port 22'],
    ['Accepted hostbased for alice from 10.0.0.5 port 22'],
    ['ssh: Permission denied for user alice'],
    [`debug1: Authenticating to bastion:22 as 'alice'`]
  ])('publishes no account name from %j', (raw) => {
    const scrubbed = scrubDiagnosticText(raw)

    expect(scrubbed).not.toContain('alice')
    expect(scrubbed).not.toContain('CONTOSO')
    expect(scrubbed).toContain('<user>')
  })

  it('leaves the surrounding diagnosis legible', () => {
    expect(
      scrubDiagnosticText(
        'Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures for alice'
      )
    ).toBe('Received disconnect from <ip> port 22:2: Too many authentication failures for <user>')
  })
})

describe('buildSshDiagnosticReport privacy', () => {
  it('drops every identifier the error text carries, in live and in the timeline', () => {
    const state = makeState({ status: 'error', error: IDENTIFYING_ERROR, connectionGeneration: 4 })
    setLocalState(state)
    recordSshStateArrival(TARGET_ID, state, 'push')

    const report = build()
    const serialized = JSON.stringify(report)

    for (const identifier of IDENTIFIERS) {
      expect(serialized).not.toContain(identifier)
    }
    expect(report.live.error).toContain('<user>@<host>')
    expect(report.live.error).toContain('<ip>')
    expect(report.live.error).toContain('<fingerprint>')
    expect(report.live.error).toContain('<path>')
    expect(report.timeline[0]?.error).toBe(report.live.error)
    // The grammar survives, which is the whole point of placeholders.
    expect(report.live.error).toContain('Permission denied (publickey).')
    expect(serialized).toContain('"connectionGeneration":4')
  })

  it('drops the unquoted and single-label shapes too', () => {
    const state = makeState({ status: 'error', error: IDENTIFYING_ERROR_UNQUOTED })
    setLocalState(state)
    recordSshStateArrival(TARGET_ID, state, 'push')

    const serialized = JSON.stringify(build())

    for (const identifier of UNQUOTED_IDENTIFIERS) {
      expect(serialized).not.toContain(identifier)
    }
  })

  it('drops a bare hostname OpenSSH names in prose', () => {
    setLocalState(
      makeState({
        status: 'error',
        error: 'ssh: Could not resolve hostname prod-db-01: nodename nor servname provided'
      })
    )

    expect(build().live.error).toBe(
      'ssh: Could not resolve hostname <host>: nodename nor servname provided'
    )
  })

  it('carries no target-identity field at all — a shape guard, not a scrub guard', () => {
    const state = makeState({
      status: 'error',
      providerEpoch: 'epoch-7f3a2b' as SshProviderEpoch
    })
    setLocalState(state)
    useAppStore.setState({ sshTargetLabels: new Map([[TARGET_ID, 'prod-builder']]) })
    recordSshStateArrival(TARGET_ID, state, 'push')

    const serialized = JSON.stringify(build())

    expect(serialized).not.toContain(TARGET_ID)
    expect(serialized).not.toContain('prod-builder')
    expect(serialized).not.toContain('providerEpoch')
  })

  it('does not mangle the retained ring — a second capture matches the first', () => {
    const dirty = 'failed reading /Users/jinjing/.ssh/config'
    recordSshStateArrival(TARGET_ID, makeState({ status: 'error', error: dirty }), 'push')
    recordSshStateArrival(TARGET_ID, makeState({ status: 'connected' }), 'push')

    const first = build()
    const second = build()

    expect(second.timeline).toEqual(first.timeline)
    expect(second.timeline[0]?.error).toBe('failed reading <path>')
    // The ring itself must still hold the raw text, not the scrubbed copy.
    expect(snapshotSshStatusTimeline(TARGET_ID)[0]?.error).toBe(dirty)
  })

  it('scrubs errors carried by timeline entries', () => {
    recordSshStateArrival(
      TARGET_ID,
      makeState({ status: 'error', error: 'failed reading /Users/jinjing/.ssh/config' }),
      'push'
    )

    const report = build()

    expect(report.timeline[0]?.error).toBe('failed reading <path>')
  })
})
