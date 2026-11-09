import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

export function shouldPresentTerminalPerfWindow(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: string = process.platform
): boolean {
  if (env.ORCA_E2E_TERMINAL_PERF_XVFB !== '1') {
    return false
  }
  if (
    platform !== 'linux' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !env.DISPLAY
  ) {
    throw new Error('Terminal perf presentation requires an isolated GitHub Actions Xvfb display')
  }
  return true
}

export async function presentTerminalPerfWindow(
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<void> {
  if (!shouldPresentTerminalPerfWindow()) {
    return
  }
  // An unpresented Linux window triggers Chromium's one-second undrawn-frame throttle.
  const visible = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.showInactive()
    }
    return windows.length > 0 && windows.every((window) => window.isVisible())
  })
  if (!visible) {
    throw new Error('Terminal perf window was not presented on the isolated display')
  }
  testInfo.annotations.push({ type: 'terminal-perf-presentation', description: 'isolated-xvfb' })
}
