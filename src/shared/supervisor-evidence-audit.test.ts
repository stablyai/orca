import { describe, expect, it } from 'vitest'
import { auditSupervisorEvidence, supersededFileFindingCodes } from './supervisor-evidence-audit'
import type { Probe, SupervisorEvidence, UnitState } from './supervisor-service-probe'

const UNAVAILABLE_REASONS = [
  'systemctl did not respond within 5000ms',
  'systemctl: Failed to connect to bus: No medium found',
  'launchctl: Could not print domain: 5: Input/output error',
  'loginctl could not be run: spawn ENOENT',
  '127.0.0.1:6800: EHOSTUNREACH'
]

function unavailable(reason: string): Probe<never> {
  return { status: 'unavailable', reason }
}

function running(overrides: Partial<UnitState> = {}): Probe<UnitState> {
  return {
    status: 'observed',
    value: {
      load: 'loaded',
      active: 'active',
      sub: 'running',
      result: 'success',
      restarts: 0,
      ...overrides
    }
  }
}

function codes(evidence: SupervisorEvidence): string[] {
  return auditSupervisorEvidence(evidence).map((finding) => finding.code)
}

describe('the never-guess rule', () => {
  // The rule that makes the doctor worth running: a probe that could not answer must never
  // produce a negative. If this fails, every finding it emits becomes untrustworthy.
  it('never turns unavailable evidence into anything but unverifiable', () => {
    for (const reason of UNAVAILABLE_REASONS) {
      const findings = auditSupervisorEvidence({
        unitState: unavailable(reason),
        linger: unavailable(reason),
        configuredPortListening: unavailable(reason)
      })
      expect(findings).toHaveLength(3)
      for (const finding of findings) {
        expect(finding.severity).toBe('unverifiable')
        // The reason has to travel, or "unverified" reads as a broken tool.
        expect(finding.message).toContain(reason)
      }
    }
  })

  it('emits nothing for a probe that was never run', () => {
    expect(auditSupervisorEvidence({})).toEqual([])
  })
})

describe('the severity boundary', () => {
  // critical means "this will destroy running terminals", and only a file can say that.
  it('never reports anything observed as critical', () => {
    const everyState: SupervisorEvidence[] = [
      { unitState: running({ active: 'failed', sub: 'failed', result: 'exit-code' }) },
      { unitState: running({ active: 'inactive', sub: 'dead' }) },
      { unitState: running() },
      { linger: { status: 'observed', value: false } },
      { configuredPortListening: { status: 'observed', value: false } },
      { unitState: unavailable('nope'), linger: unavailable('nope') }
    ]
    for (const evidence of everyState) {
      for (const finding of auditSupervisorEvidence(evidence)) {
        expect(finding.severity).not.toBe('critical')
      }
    }
  })
})

describe('unit state', () => {
  it('explains that a failed unit will not recover on its own', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ active: 'failed', sub: 'failed', result: 'exit-code', restarts: 3 })
    })
    expect(findings[0].code).toBe('unit_failed')
    expect(findings[0].message).toMatch(/permanently/)
    expect(findings[0].remedy).toContain('reset-failed')
  })

  it('does not scold an operator for a service they stopped', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ active: 'inactive', sub: 'dead' })
    })
    expect(findings[0].code).toBe('unit_inactive')
    expect(findings[0].message).toMatch(/Deliberate if you stopped it/)
  })

  it('reports a running unit as ok', () => {
    expect(codes({ unitState: running() })).toEqual(['unit_active'])
  })
})

describe('lingering', () => {
  it('answers the question the file audit could only call unreadable', () => {
    expect(codes({ linger: { status: 'observed', value: true } })).toEqual(['linger_enabled'])
    expect(codes({ linger: { status: 'observed', value: false } })).toEqual(['linger_disabled'])
  })
})

describe('configured port', () => {
  it('claims only that something is listening, never that it is orcad', () => {
    const findings = auditSupervisorEvidence({
      configuredPortListening: { status: 'observed', value: true }
    })
    expect(findings[0].message).toBe('Something is listening on the configured port.')
    expect(findings[0].message).not.toMatch(/orcad/i)
  })

  it('reads an active unit with a silent port as the documented port fallback', () => {
    const findings = auditSupervisorEvidence({
      unitState: running(),
      configuredPortListening: { status: 'observed', value: false }
    })
    const port = findings.find((finding) => finding.code === 'configured_port_silent')
    expect(port?.message).toMatch(/falls back to an OS-assigned one/)
  })

  it('does not blame the fallback when the service is not even running', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ active: 'inactive', sub: 'dead' }),
      configuredPortListening: { status: 'observed', value: false }
    })
    const port = findings.find((finding) => finding.code === 'configured_port_silent')
    expect(port?.message).toBe('Nothing is listening on the configured port.')
  })
})

describe('load state', () => {
  // The likeliest mistake in a print-and-place workflow: the file is written but never
  // loaded. systemctl show exits 0 and calls that `inactive`, which is also what a service
  // someone deliberately stopped looks like.
  it('separates a never-loaded unit from a stopped one', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ load: 'not-found', active: 'inactive', sub: 'dead' })
    })
    expect(findings[0].code).toBe('unit_not_loaded')
    expect(findings[0].message).toMatch(/Placing the file is not the last step/)
    expect(findings[0].remedy).toContain('daemon-reload')
  })

  it('reports a masked unit, which no file contents can fix', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ load: 'masked', active: 'inactive', sub: 'dead' })
    })
    expect(findings[0].code).toBe('unit_masked')
  })

  it('still reports a genuinely stopped loaded unit as stopped', () => {
    const findings = auditSupervisorEvidence({
      unitState: running({ load: 'loaded', active: 'inactive', sub: 'dead' })
    })
    expect(findings[0].code).toBe('unit_inactive')
  })
})

describe('exec target on disk', () => {
  // A unit can be well-formed and name an interpreter that no longer exists — what a
  // version-scoped path becomes one package-manager upgrade later.
  it('reports a missing interpreter as a warning, not a critical', () => {
    const findings = auditSupervisorEvidence({
      execTarget: {
        status: 'observed',
        value: {
          interpreter: '/home/linuxbrew/.linuxbrew/Cellar/node/25.8.0/bin/node',
          interpreterExists: false,
          script: '/opt/orcad/orcad.js',
          scriptExists: true
        }
      }
    })
    expect(findings[0].code).toBe('exec_target_absent')
    // It cannot start, but it destroys no running terminals.
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].message).toMatch(/203\/EXEC/)
  })

  it('names the missing script too', () => {
    const findings = auditSupervisorEvidence({
      execTarget: {
        status: 'observed',
        value: {
          interpreter: '/usr/bin/node',
          interpreterExists: true,
          script: '/opt/orcad/orcad.js',
          scriptExists: false
        }
      }
    })
    expect(findings[0].message).toContain('/opt/orcad/orcad.js')
  })

  it('passes when both resolve', () => {
    expect(
      codes({
        execTarget: {
          status: 'observed',
          value: {
            interpreter: '/usr/bin/node',
            interpreterExists: true,
            script: '/opt/orcad/orcad.js',
            scriptExists: true
          }
        }
      })
    ).toEqual(['exec_target_present'])
  })
})

describe('journal persistence', () => {
  it('flags a volatile journal for a unit that logs to it', () => {
    const findings = auditSupervisorEvidence({
      journal: { status: 'observed', value: { storage: 'volatile', unitUsesJournal: true } }
    })
    expect(findings[0].code).toBe('journal_volatile')
    expect(findings[0].severity).toBe('warning')
    expect(findings[0].message).toMatch(/reboot/)
  })

  it('says nothing when the unit does not log to the journal', () => {
    expect(
      codes({
        journal: { status: 'observed', value: { storage: 'volatile', unitUsesJournal: false } }
      })
    ).toEqual([])
  })

  it('says nothing when the journal is persistent', () => {
    expect(
      codes({
        journal: { status: 'observed', value: { storage: 'persistent', unitUsesJournal: true } }
      })
    ).toEqual([])
  })
})

describe('data root identity', () => {
  // Two spellings of one directory are not a split profile. Since the generator began
  // pinning a realpath, a host whose root sits behind a symlink reported a mismatch on
  // every run — noise, by construction, on every such host.
  it('reports the roots as one directory when they resolve the same', () => {
    expect(codes({ dataRootSameDirectory: { status: 'observed', value: true } })).toEqual([
      'user_data_same_directory'
    ])
  })

  it('supersedes the file audit string mismatch when they are one directory', () => {
    const live = auditSupervisorEvidence({
      dataRootSameDirectory: { status: 'observed', value: true }
    })
    expect(supersededFileFindingCodes(live)).toContain('user_data_mismatch')
  })

  it('leaves a genuine mismatch to the file audit', () => {
    expect(codes({ dataRootSameDirectory: { status: 'observed', value: false } })).toEqual([])
    expect(
      supersededFileFindingCodes(
        auditSupervisorEvidence({ dataRootSameDirectory: { status: 'observed', value: false } })
      )
    ).not.toContain('user_data_mismatch')
  })
})
