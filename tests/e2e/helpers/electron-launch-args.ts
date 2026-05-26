export function getOrcaElectronLaunchArgs(mainPath: string, headful: boolean): string[] {
  if (headful || process.platform !== 'linux') {
    return [mainPath]
  }

  // Why: Ubuntu CI can fail headless Electron when Chromium's GPU subprocess
  // cannot initialize; these switches keep rendering on a software-safe path.
  return ['--disable-gpu', '--disable-dev-shm-usage', mainPath]
}
