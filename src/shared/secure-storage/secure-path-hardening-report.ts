/** Keep reporting independent of ACL application so retry budgets can announce degradation/recovery without the Windows lane. */
export type SecurePathHardeningReport = {
  targetPath: string
  /** throttled/recovered bracket rate-limited degradation; addon load failure reports once per process. */
  stage: 'addon' | 'apply' | 'verify' | 'throttled' | 'recovered'
  detail: string
}

/** Packaged Windows main has no console; install a trace reporter there. Console fallback serves dev/CLI. */
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
