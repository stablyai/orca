/**
 * Where path-hardening outcomes are announced, kept apart from the code that applies them so the
 * retry budget can report degradation and recovery without importing the Windows ACL lane.
 */
export type SecurePathHardeningReport = {
  targetPath: string
  /**
   * `throttled` and `recovered` mark entering and leaving the rate-limited degraded state;
   * `addon` is the native ACL module failing to load, reported once per process.
   */
  stage: 'addon' | 'apply' | 'verify' | 'throttled' | 'recovered'
  detail: string
}

/**
 * Why a hook: hardening runs in the Electron main process, which is GUI-subsystem on Windows and
 * owns no console, so `console.warn` reaches nothing in a packaged build. The main process
 * installs a reporter that routes into the diagnostic trace; the console default keeps dev runs
 * and the CLI readable.
 */
const consoleReporter = (entry: SecurePathHardeningReport): void => {
  if (entry.stage === 'recovered') {
    console.info('[secure-path.windows-acl] path hardening recovered', entry)
    return
  }
  console.warn('[secure-path.windows-acl] failed to restrict path', entry)
}

let reportEntry: (entry: SecurePathHardeningReport) => void = consoleReporter

export function setSecurePathHardeningReporter(
  reporter: ((entry: SecurePathHardeningReport) => void) | null
): void {
  reportEntry = reporter ?? consoleReporter
}

export function reportSecurePathHardening(
  targetPath: string,
  stage: SecurePathHardeningReport['stage'],
  detail: string
): void {
  try {
    reportEntry({ targetPath, stage, detail: detail.trim().slice(0, 500) })
  } catch {
    // A throwing caller-installed reporter must not break hardening; this diagnostic is lost.
  }
}
