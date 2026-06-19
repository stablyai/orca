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
    mainPath
  ]
}
