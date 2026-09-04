import { describe, expect, it } from 'vitest'
import {
  auditSupervisorServices,
  readConfiguredEndpoint,
  sortBySeverity,
  supervisorAuditPassed,
  type SupervisorServiceFile
} from './supervisor-service-audit'
import { renderSupervisorService } from './supervisor-service-render'

const ROOT = '/home/orca/.orca'

function file(overrides: Partial<SupervisorServiceFile> = {}): SupervisorServiceFile {
  return {
    path: '/etc/systemd/system/orcad.service',
    platform: 'systemd',
    scope: 'system',
    text: renderSupervisorService({
      platform: 'systemd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath: ROOT,
      user: 'orca',
      bind: '127.0.0.1',
      port: 6800
    }),
    ...overrides
  }
}

function audit(files: SupervisorServiceFile[], expected = ROOT) {
  return auditSupervisorServices({ files, expectedUserDataPath: expected })
}

function codes(files: SupervisorServiceFile[], expected = ROOT): string[] {
  return audit(files, expected).map((finding) => finding.code)
}

/**
 * A `.replace()` that matches nothing returns the string unchanged and the test then
 * asserts against the unmodified unit. Three tests below went vacuous exactly that way
 * when the rendered default moved off `mixed`: they kept passing a healthy unit to an
 * audit and expecting a failure code. Substitutions here must land.
 */
function swapKillMode(text: string, replacement: string): string {
  const swapped = text.replace('KillMode=process', replacement)
  if (swapped === text) {
    throw new Error('the rendered unit no longer contains KillMode=process; update this test')
  }
  return swapped
}

/** What `brew services` produces: a plausible unit with no KillMode at all. */
const HOMEBREW_SHAPED_UNIT = `[Unit]
Description=Homebrew generated unit for orcad

[Service]
Type=simple
ExecStart=/opt/homebrew/bin/node /opt/homebrew/opt/orcad/orcad.js
Restart=always
User=orca
Environment=ORCA_USER_DATA=${ROOT}

[Install]
WantedBy=multi-user.target
`

describe('kill semantics', () => {
  it('passes its own rendered output', () => {
    expect(supervisorAuditPassed(audit([file()]))).toBe(true)
  })

  it('flags a brew-services-shaped unit as critical', () => {
    const findings = audit([file({ text: HOMEBREW_SHAPED_UNIT })])
    expect(findings[0].code).toBe('kill_mode_missing')
    expect(findings[0].severity).toBe('critical')
    expect(supervisorAuditPassed(findings)).toBe(false)
  })

  it('flags an explicit control-group', () => {
    const text = swapKillMode(file().text, 'KillMode=control-group')
    expect(codes([file({ text })])).toContain('kill_mode_reaps_group')
  })

  // The mode orcad itself generated until a NAS restart destroyed a live terminal under
  // it. mixed SIGKILLs whatever remains in the cgroup once the main process is gone, and
  // the detached daemon is in the cgroup: setsid escapes the process group, not the cgroup.
  it('flags KillMode=mixed, which orcad used to generate, as critical', () => {
    const text = swapKillMode(file().text, 'KillMode=mixed')
    const findings = audit([file({ text })])
    expect(findings[0].code).toBe('kill_mode_mixed_reaps_daemon')
    expect(findings[0].severity).toBe('critical')
    expect(supervisorAuditPassed(findings)).toBe(false)
    // The remedy has to name the mode that works, not the one being rejected.
    expect(findings[0].remedy).toContain('KillMode=process')
  })

  it('warns rather than blesses KillMode=none, which signals nothing at all', () => {
    const text = swapKillMode(file().text, 'KillMode=none')
    const findings = audit([file({ text })])
    expect(findings.map((f) => f.code)).toContain('kill_mode_discouraged')
    // It spares the daemon, so it is not the critical failure this audit exists to catch.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })

  it('does not read a commented-out KillMode as set', () => {
    const text = swapKillMode(file().text, '# KillMode=process')
    expect(codes([file({ text })])).toContain('kill_mode_missing')
  })

  it('accepts a plist only when AbandonProcessGroup is stated', () => {
    const plist = renderSupervisorService({
      platform: 'launchd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath: ROOT,
      user: 'orca',
      bind: '127.0.0.1',
      port: 6800
    })
    expect(codes([file({ platform: 'launchd', text: plist })])).toContain('kill_semantics_safe')

    const stripped = plist.replace(/<key>AbandonProcessGroup<\/key>\s*<true\/>/, '')
    const findings = audit([file({ platform: 'launchd', text: stripped })])
    expect(findings.map((f) => f.code)).toContain('kill_semantics_implicit')
    // Implicit survival is a warning, not a failure: it does work today.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })
})

describe('data root', () => {
  it('flags an unpinned root as critical', () => {
    const text = file().text.replace(`Environment=ORCA_USER_DATA=${ROOT}`, '')
    expect(codes([file({ text })])).toContain('user_data_unpinned')
  })

  it('reports disagreement with the calling shell as a warning, not a failure', () => {
    const findings = audit([file()], '/home/someone-else/.orca')
    expect(findings.map((f) => f.code)).toContain('user_data_mismatch')
    expect(supervisorAuditPassed(findings)).toBe(true)
  })

  // The end-to-end form of the escape/decode pair: the generator writes `&` as `&amp;`, so
  // an audit that does not decode compares two spellings of one path and accuses the plist
  // this tool just produced of pointing somewhere else.
  it('does not accuse its own plist of a mismatch over an escaped character', () => {
    const escapedRoot = '/Volumes/a&b/.orca'
    const plist: SupervisorServiceFile = {
      path: '/Library/LaunchDaemons/dev.onorca.orcad.plist',
      platform: 'launchd',
      scope: 'system',
      text: renderSupervisorService({
        platform: 'launchd',
        scope: 'system',
        nodePath: '/usr/local/bin/node',
        orcadPath: '/opt/orcad/orcad.js',
        userDataPath: escapedRoot,
        user: 'orca',
        bind: '127.0.0.1',
        port: 6800,
        logPath: '/var/log/orcad.log'
      })
    }
    expect(codes([plist], escapedRoot)).not.toContain('user_data_mismatch')
  })
})

describe('run-as account', () => {
  it('flags a system unit with no User', () => {
    const text = file().text.replace('User=orca', '')
    expect(codes([file({ text })])).toContain('run_as_user_unset')
  })

  it('flags User=root', () => {
    const text = file().text.replace('User=orca', 'User=root')
    expect(codes([file({ text })])).toContain('run_as_root')
  })

  // `User=0` is root spelled numerically, which systemd accepts. A name-only check reads it
  // back as an ordinary account and reports `Runs as 0.` as healthy — the audit has to know
  // the same rule the generator's guard does, or the numeric spelling walks between them.
  it('flags the numeric spelling of root too', () => {
    const text = file().text.replace('User=orca', 'User=0')
    expect(codes([file({ text })])).toContain('run_as_root')
  })

  it('does not flag an ordinary account that merely ends in a digit', () => {
    const text = file().text.replace('User=orca', 'User=orca0')
    expect(codes([file({ text })])).toContain('run_as_user_set')
  })

  it('accepts a user-scope unit with no User', () => {
    const text = file().text.replace('User=orca', '')
    const findings = audit([file({ text, scope: 'user' })])
    expect(supervisorAuditPassed(findings)).toBe(true)
  })
})

describe('duplicates', () => {
  it('ranks two services on one data root above everything else', () => {
    const findings = audit([
      file(),
      file({ path: '/home/orca/.config/systemd/user/orcad.service', scope: 'user' })
    ])
    expect(findings[0].code).toBe('multiple_services_one_root')
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].message).toMatch(/exits 78/)
  })

  it('treats distinct roots as a warning only', () => {
    const other = file({
      path: '/home/orca/.config/systemd/user/orcad.service',
      scope: 'user',
      // replaceAll: the root appears in both RequiresMountsFor and Environment, and
      // rewriting only the first leaves the two files still sharing a data root.
      text: file().text.replaceAll(ROOT, '/srv/other/.orca')
    })
    const findings = audit([file(), other])
    expect(findings.map((f) => f.code)).toContain('multiple_services_distinct_roots')
  })
})

describe('unverifiable is never a negative verdict', () => {
  it('reports a missing service as unverified rather than clean or failed', () => {
    const findings = audit([])
    expect(findings[0].severity).toBe('unverifiable')
    // Nothing found is not evidence of a broken host, so it must not fail the audit.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })

  it('reports lingering as unreadable from a user unit rather than guessing', () => {
    const findings = audit([file({ scope: 'user' })])
    const linger = findings.find((f) => f.code === 'linger_unverified')
    expect(linger?.severity).toBe('unverifiable')
    expect(linger?.remedy).toContain('enable-linger')
  })

  it('warns that a LaunchAgent dies at logout', () => {
    expect(codes([file({ platform: 'launchd', scope: 'user' })])).toContain('launch_agent_scope')
  })
})

describe('configured endpoint', () => {
  // Probing a flag default while the file names another port answers the wrong question
  // with full confidence — caught by running it, not by reading it.
  it('reads the endpoint the installed file will actually bind', () => {
    const text = file()
      .text.replace('--port 6800', '--port 6899')
      .replace('--bind 127.0.0.1', '--bind 0.0.0.0')
    expect(readConfiguredEndpoint(file({ text }))).toEqual({ bind: '0.0.0.0', port: 6899 })
  })

  it('reads it out of plist ProgramArguments too', () => {
    const plist = renderSupervisorService({
      platform: 'launchd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath: ROOT,
      user: 'orca',
      bind: '127.0.0.1',
      port: 7100
    })
    expect(readConfiguredEndpoint(file({ platform: 'launchd', text: plist }))?.port).toBe(7100)
  })

  it('returns null rather than a guess when no port is named', () => {
    expect(readConfiguredEndpoint(file({ text: HOMEBREW_SHAPED_UNIT }))).toBeNull()
  })
})

describe('severity ordering', () => {
  // A finding appended by a caller after the audit returned was landing past the OK rows,
  // where an operator scanning top-down stops reading before reaching it.
  it('keeps every severity in rank order, including appended findings', () => {
    const sorted = sortBySeverity([
      { code: 'a', severity: 'ok', message: 'ok' },
      { code: 'b', severity: 'unverifiable', message: 'appended late' },
      { code: 'c', severity: 'critical', message: 'critical' },
      { code: 'd', severity: 'ok', message: 'ok' },
      { code: 'e', severity: 'warning', message: 'warning' }
    ])
    expect(sorted.map((finding) => finding.severity)).toEqual([
      'critical',
      'warning',
      'unverifiable',
      'ok',
      'ok'
    ])
  })

  it("does not mutate the caller's array", () => {
    const input: Parameters<typeof sortBySeverity>[0] = [
      { code: 'a', severity: 'ok', message: 'ok' },
      { code: 'b', severity: 'critical', message: 'critical' }
    ]
    sortBySeverity(input)
    expect(input.map((finding) => finding.code)).toEqual(['a', 'b'])
  })
})

describe('live evidence supersedes the file-level unknown', () => {
  it('drops the unreadable-linger finding once a live reading answers it', () => {
    const findings = auditSupervisorServices({
      files: [file({ scope: 'user' })],
      expectedUserDataPath: ROOT,
      evidence: { linger: { status: 'observed', value: true } }
    })
    const codes = findings.map((finding) => finding.code)
    expect(codes).toContain('linger_enabled')
    expect(codes).not.toContain('linger_unverified')
  })

  it('keeps it when there is no evidence at all', () => {
    expect(codes([file({ scope: 'user' })])).toContain('linger_unverified')
  })
})

/**
 * An unreadable definition and an absent one demand opposite actions, so they must not
 * share a finding. `existsSync` succeeds on a file the caller cannot open, which is how a
 * unit installed mode 600 — what `sudo tee` writes under root's 0077 umask on Synology DSM
 * — used to be reported as "no orcad service definition found in the conventional
 * locations", with `--print-service` as the remedy: redo an install that had succeeded.
 */
describe('a definition that exists but cannot be read', () => {
  const unreadable = [{ path: '/etc/systemd/system/orcad.service', reason: 'EACCES' }]

  it('is not reported as an absent install', () => {
    const found = auditSupervisorServices({ files: [], expectedUserDataPath: ROOT, unreadable })
    const codes = found.map((f) => f.code)
    expect(codes).toContain('service_definition_unreadable')
    expect(codes).not.toContain('no_service_found')
  })

  it('never tells the operator to print a unit they already installed', () => {
    const [finding] = auditSupervisorServices({
      files: [],
      expectedUserDataPath: ROOT,
      unreadable
    })
    expect(finding.remedy).not.toContain('--print-service')
    expect(finding.remedy).toContain('/etc/systemd/system/orcad.service')
  })

  it('names the path and the errno, since neither alone identifies the problem', () => {
    const [finding] = auditSupervisorServices({
      files: [],
      expectedUserDataPath: ROOT,
      unreadable
    })
    expect(finding.message).toContain('/etc/systemd/system/orcad.service')
    expect(finding.message).toContain('EACCES')
  })

  // An unreadable second file is exactly the duplicate auditDuplicates exists to catch,
  // and it cannot see this one — so silence here would hide the higher-severity finding.
  it('is still reported when another definition did read cleanly', () => {
    const codes = auditSupervisorServices({
      files: [file()],
      expectedUserDataPath: ROOT,
      unreadable: [{ path: '/usr/lib/systemd/system/orcad.service', reason: 'EACCES' }]
    }).map((f) => f.code)
    expect(codes).toContain('service_definition_unreadable')
  })

  it('still reports a genuinely absent install as absent (negative control)', () => {
    const codes = auditSupervisorServices({
      files: [],
      expectedUserDataPath: ROOT,
      unreadable: []
    }).map((f) => f.code)
    expect(codes).toContain('no_service_found')
    expect(codes).not.toContain('service_definition_unreadable')
  })
})
