const REQUIRED_EXPORTS = ['assignCurrentProcessToJob', 'listJobProcessIds', 'terminateJob']
const FIXTURE_TOKEN_PATTERN = /^[a-f0-9]{64}$/

function isFixtureObservation(value, expected) {
  return (
    Number.isInteger(value?.pid) &&
    value.pid > 0 &&
    value.fixtureToken === expected.fixtureToken &&
    value.channel === expected.channel &&
    value.role === expected.role
  )
}

function isFixtureClosure(value, expected) {
  return (
    value?.fixtureToken === expected.fixtureToken &&
    value.channel === expected.channel &&
    value.role === expected.role
  )
}

function isPtyExit(value, terminalHandle) {
  return value?.terminalHandle === terminalHandle && Number.isInteger(value.exitCode)
}

export function evaluatePackagedNodePtyCapability(evidence) {
  const failures = []
  const exports = new Set(evidence?.patchedExports ?? [])
  const fixtureToken = evidence?.fixtureToken
  const channel = evidence?.channel
  const target = evidence?.target
  const canary = evidence?.canary

  if (REQUIRED_EXPORTS.some((name) => !exports.has(name))) {
    failures.push('the packaged node-pty addon is missing a required patched export')
  }
  if (!FIXTURE_TOKEN_PATTERN.test(fixtureToken) || !channel?.includes(fixtureToken)) {
    failures.push('the fixture channel is not bound to the per-run unguessable token')
  }
  if (!isFixtureObservation(target?.shell, { fixtureToken, channel, role: 'target-shell' })) {
    failures.push('the target shell was not observed on its unique fixture channel')
  }
  if (
    !isFixtureObservation(target?.launcherExited, {
      fixtureToken,
      channel,
      role: 'target-launcher-exited'
    })
  ) {
    failures.push('the transient launcher exit was not observed')
  }
  if (
    !isFixtureObservation(target?.grandchild, {
      fixtureToken,
      channel,
      role: 'target-grandchild'
    })
  ) {
    failures.push('the grandchild was not observed after its launcher exited')
  }
  if (!isFixtureObservation(canary?.process, { fixtureToken, channel, role: 'canary-shell' })) {
    failures.push('the unrelated canary was not observed on its unique fixture channel')
  }
  const observedPids = [
    target?.shell?.pid,
    target?.launcherExited?.pid,
    target?.grandchild?.pid,
    canary?.process?.pid
  ]
  if (observedPids.every((pid) => Number.isInteger(pid)) && new Set(observedPids).size !== 4) {
    failures.push('target shell, launcher, grandchild, and canary must be distinct processes')
  }

  if (!Array.isArray(target?.jobProcessIds) || target.jobProcessIds.length === 0) {
    failures.push('the target job membership must be available and nonempty')
  } else if (!target.jobProcessIds.includes(target?.shell?.pid)) {
    failures.push('the target job does not contain the observed shell PID')
  } else if (!target.jobProcessIds.includes(target?.grandchild?.pid)) {
    failures.push('the target job does not contain the observed grandchild PID')
  } else if (target.jobProcessIds.includes(target?.launcherExited?.pid)) {
    failures.push('the transient launcher is still live in the target job')
  }
  const close = evidence?.close
  if (
    close?.method !== 'terminate-job' ||
    close?.requestedHandle !== target?.terminalHandle ||
    close?.completedHandle !== target?.terminalHandle
  ) {
    failures.push('close must complete for the one requested PTY job handle')
  }
  if (
    !isPtyExit(close?.targetExit, target?.terminalHandle) ||
    !isFixtureClosure(close?.targetShellClosed, {
      fixtureToken,
      channel,
      role: 'target-shell'
    }) ||
    !isFixtureClosure(close?.targetGrandchildClosed, {
      fixtureToken,
      channel,
      role: 'target-grandchild'
    })
  ) {
    failures.push('target close did not complete from PTY and fixture socket exit events')
  }

  if (canary?.connectedAfterTargetClose !== true) {
    failures.push('the unrelated canary fixture connection was lost during target close')
  }
  if (
    !Array.isArray(canary?.jobProcessIdsAfterTargetClose) ||
    !canary.jobProcessIdsAfterTargetClose.includes(canary?.process?.pid)
  ) {
    failures.push('the unrelated canary PID is not live in its job after target close')
  }
  if (!isPtyExit(canary?.exit, canary?.terminalHandle)) {
    failures.push('the unrelated canary PTY exit was not observed')
  }
  if (
    !isFixtureClosure(canary?.socketClosed, {
      fixtureToken,
      channel,
      role: 'canary-shell'
    })
  ) {
    failures.push('the unrelated canary did not complete its later exact teardown')
  }

  return { pass: failures.length === 0, failures }
}

export function assertPackagedNodePtyCapability(evidence) {
  const result = evaluatePackagedNodePtyCapability(evidence)
  if (!result.pass) {
    throw new Error(
      `Packaged node-pty native capability failed:\n- ${result.failures.join('\n- ')}`
    )
  }
}
