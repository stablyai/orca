import { dirname } from 'node:path'

export function getElectronIsolatedKeychainArgs(): string[] {
  // Isolated macOS profiles must not invoke the system keychain UI.
  return process.platform === 'darwin' ? ['--password-store=basic', '--use-mock-keychain'] : []
}

export function getOrcaElectronLaunchArgs(mainPath: string, headful: boolean): string[] {
  // Launch through package.json so app version and resource paths match a packaged app.
  const appPath = dirname(dirname(dirname(mainPath)))
  const keychainArgs = getElectronIsolatedKeychainArgs()
  if (process.platform === 'darwin') {
    // Crash tests must not block later launches on AppKit's saved-window recovery dialog.
    return [...keychainArgs, appPath, '-ApplePersistenceIgnoreState', 'YES']
  }
  if (headful && process.platform === 'linux' && process.env.CI) {
    // Hosted runners have no GPU; SwiftShader keeps WebGL assertions from silently skipping.
    return [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      appPath
    ]
  }
  if (headful || process.platform !== 'linux') {
    return [...keychainArgs, appPath]
  }

  // Match Playwright’s --no-sandbox for raw launches: CI’s unprivileged chrome-sandbox otherwise aborts with SIGTRAP.
  // Keep software GPU flags for headless Xvfb when GPU initialization fails.
  return [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--in-process-gpu',
    ...keychainArgs,
    appPath
  ]
}
