// Resolve one authoritative daemon identity from the userData-scoped process
// scan and its advisory PID file metadata.

/**
 * Require exactly one live, scoped daemon and cross-check any PID-file record.
 * The process command line owns identity; a stale PID file must never turn an
 * unrelated recycled PID into false crash-survival evidence.
 */
export function selectScopedDaemon(pidFiles, scannedProcesses) {
  if (scannedProcesses.length !== 1) {
    throw new Error(`expected exactly one userData-scoped daemon, found ${scannedProcesses.length}`)
  }

  const processRecord = scannedProcesses[0]
  const numericPidFiles = pidFiles.filter((record) => Number.isInteger(record.pid))
  const matchingPidFile = numericPidFiles.find((record) => record.pid === processRecord.pid)
  if (numericPidFiles.length > 0 && !matchingPidFile) {
    throw new Error(
      `daemon PID file does not match scoped live daemon ${processRecord.pid} ` +
        `(recorded: ${numericPidFiles.map((record) => record.pid).join(', ')})`
    )
  }

  return {
    pid: processRecord.pid,
    appVersion: matchingPidFile?.appVersion ?? null
  }
}
