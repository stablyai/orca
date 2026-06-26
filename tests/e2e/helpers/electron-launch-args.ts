export function getOrcaElectronLaunchArgs(mainPath: string, headful: boolean): string[] {
  if (headful || process.platform !== 'linux') {
    return [mainPath]
  }

  // Why: Ubuntu CI can fail headless Electron when Chromium's GPU subprocess
  // cannot initialize; keep E2E on a low-process software path under Xvfb.
  return [
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    // Why: unprivileged containers (no user-namespace / non-suid sandbox) can't
    // start Chromium's sandbox; opt out so headless E2E runs there. Gated on an
    // env var so CI keeps its sandboxed default.
    ...(process.env.ORCA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    mainPath
  ]
}
