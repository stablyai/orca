/**
 * Turns live evidence about a running orcad service into findings.
 *
 * Split from the file audit for one reason worth stating plainly: `critical` means THIS
 * CONFIGURATION WILL DESTROY RUNNING TERMINALS, and only a file can say that. Nothing
 * observed here is ever critical — a service an operator deliberately stopped is a fact
 * worth reporting, not a failure, and an exit code that fires on ordinary states is one
 * people stop reading. A separate module keeps that boundary visible rather than
 * re-decided per check.
 *
 * Pure like its sibling: evidence in, findings out, so every `unavailable` reason is
 * assertable without running a subprocess.
 */
import type { SupervisorFinding } from './supervisor-service-audit'
import type { Probe, SupervisorEvidence } from './supervisor-service-probe'

/** One shape for every unreadable probe, so the reason never gets flattened away. */
function unverified<T>(code: string, probe: Probe<T>, subject: string): SupervisorFinding {
  return {
    code,
    severity: 'unverifiable',
    message: `${subject} could not be established: ${
      probe.status === 'unavailable' ? probe.reason : 'no probe ran'
    }`
  }
}

function auditUnitState(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.unitState
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('unit_state_unverified', probe, 'Whether the service is running')
  }
  const { load, active, sub, result, restarts } = probe.value
  // Checked before ActiveState, which reads `inactive` for a unit the supervisor has
  // never loaded — the same answer as a service someone deliberately stopped.
  if (load === 'not-found') {
    return {
      code: 'unit_not_loaded',
      severity: 'warning',
      message:
        'The file is on disk but the supervisor has never loaded it, so nothing is ' +
        'supervising orcad. Placing the file is not the last step.',
      remedy: 'systemctl daemon-reload, then systemctl enable <unit>, then systemctl start <unit>'
    }
  }
  if (load === 'masked') {
    return {
      code: 'unit_masked',
      severity: 'warning',
      message: 'The unit is masked, so it will never start no matter what the file says.',
      remedy: 'systemctl unmask <unit>'
    }
  }
  // A failed unit after exit 78 is the stranding the generated file warns about: it will
  // not come back on its own even once the cause is gone.
  if (active === 'failed') {
    return {
      code: 'unit_failed',
      severity: 'warning',
      message: `Service is failed (${sub}, result=${result}, ${restarts} restarts). Exit 78 leaves it here permanently, including after the cause is fixed.`,
      remedy: 'systemctl reset-failed, then start it again'
    }
  }
  if (active !== 'active') {
    return {
      code: 'unit_inactive',
      severity: 'warning',
      message: `Service is ${active} (${sub}). Deliberate if you stopped it.`
    }
  }
  return { code: 'unit_active', severity: 'ok', message: `Service is active (${sub}).` }
}

function auditLinger(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.linger
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('linger_unverified_live', probe, 'Whether the service survives logout')
  }
  return probe.value
    ? {
        code: 'linger_enabled',
        severity: 'ok',
        message: 'Lingering is enabled: the service survives logout.'
      }
    : {
        code: 'linger_disabled',
        severity: 'warning',
        message:
          'Lingering is disabled, so this user-scope service stops when your last session ends.',
        remedy: 'sudo loginctl enable-linger "$USER"'
      }
}

/**
 * Worded as what was observed. A listener is not proof it is orcad — anything on the host
 * could hold that port, which is exactly the conflict that causes the fallback this check
 * exists to surface.
 */
function auditConfiguredPort(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.configuredPortListening
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('configured_port_unverified', probe, 'Whether the configured port is served')
  }
  if (probe.value) {
    return {
      code: 'configured_port_listening',
      severity: 'ok',
      message: 'Something is listening on the configured port.'
    }
  }
  const active =
    evidence.unitState?.status === 'observed' && evidence.unitState.value.active === 'active'
  return {
    code: 'configured_port_silent',
    severity: 'warning',
    message: active
      ? 'The service is active but nothing is listening on the configured port — a pinned port still falls back to an OS-assigned one on conflict.'
      : 'Nothing is listening on the configured port.',
    remedy: active
      ? 'Check the bound endpoint in the readiness line before relying on an SSH forward.'
      : undefined
  }
}

/**
 * File-level findings that a live answer replaces. Declared here because this module owns
 * the knowledge; the caller matching on code prefixes coupled the two by string shape, and
 * any future `linger*` code would have silently changed which findings got dropped.
 */
export function supersededFileFindingCodes(live: readonly SupervisorFinding[]): string[] {
  const superseded: string[] = []
  if (live.some((finding) => LINGER_CODES.has(finding.code))) {
    superseded.push('linger_unverified')
  }
  // The file audit can only compare the two roots as strings, which since the generator
  // began pinning a realpath reads two spellings of one directory as a split profile.
  if (live.some((finding) => finding.code === 'user_data_same_directory')) {
    superseded.push('user_data_mismatch')
  }
  return superseded
}

const LINGER_CODES = new Set(['linger_enabled', 'linger_disabled', 'linger_unverified_live'])

/**
 * A unit can be perfectly well-formed and name an interpreter that no longer exists — a
 * version-scoped path one package-manager upgrade later. It cannot start, so it is a
 * warning; it destroys no running terminals, so it is not critical.
 */
function auditExecTargetOnDisk(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.execTarget
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('exec_target_unverified', probe, 'Whether ExecStart can be executed')
  }
  const { interpreter, interpreterExists, script, scriptExists } = probe.value
  const missing = [
    ...(interpreterExists ? [] : [`interpreter ${interpreter}`]),
    ...(script && !scriptExists ? [`script ${script}`] : [])
  ]
  if (missing.length === 0) {
    return { code: 'exec_target_present', severity: 'ok', message: 'ExecStart resolves on disk.' }
  }
  return {
    code: 'exec_target_absent',
    severity: 'warning',
    message: `ExecStart does not exist on disk: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} missing, so the service cannot start (203/EXEC).`,
    remedy: 'Regenerate with orcad --print-service, passing --node with a stable path.'
  }
}

/**
 * The generated unit logs to journald because orcad rotates nothing of its own — sound
 * reasoning that assumes a persistent, readable journal. Appliance hosts routinely set
 * `Storage=volatile`, which puts the journal in /run and loses it on reboot.
 */
function auditJournalPersistence(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.journal
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('journal_storage_unverified', probe, "journald's storage mode")
  }
  const { storage, unitUsesJournal } = probe.value
  if (!unitUsesJournal || storage !== 'volatile') {
    return null
  }
  return {
    code: 'journal_volatile',
    severity: 'warning',
    message:
      'The unit logs to the journal, but journald Storage=volatile keeps the journal in ' +
      '/run, so these logs do not persist across a reboot and are gone exactly when you ' +
      'would go looking for why the host restarted.',
    remedy: 'Set Storage=persistent in journald.conf, or point the unit at a file you rotate.'
  }
}

function auditDataRootIdentity(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.dataRootSameDirectory
  if (!probe || probe.status !== 'observed' || !probe.value) {
    // A genuine mismatch needs no finding here: the file audit already reported it.
    return null
  }
  return {
    code: 'user_data_same_directory',
    severity: 'ok',
    message: 'The service and this shell resolve the same data root directory.'
  }
}

export function auditSupervisorEvidence(evidence: SupervisorEvidence): SupervisorFinding[] {
  return [
    auditDataRootIdentity(evidence),
    auditUnitState(evidence),
    auditLinger(evidence),
    auditConfiguredPort(evidence),
    auditExecTargetOnDisk(evidence),
    auditJournalPersistence(evidence)
  ].filter((finding): finding is SupervisorFinding => finding !== null)
}
