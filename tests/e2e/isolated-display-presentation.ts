import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'

// Fail closed: a flag set outside a hosted Linux runner's own Xvfb display is an error, never a
// silent downgrade to presenting. Each exception in tests/AGENTS.md owns a distinct flag so one
// can never enable another.

export type IsolatedDisplayEnv = Readonly<Record<string, string | undefined>>

export type IsolatedDisplayExemption = {
  flag: string
  requirement: string
  annotation: string
  absent: string
}

export function shouldPresentOnIsolatedDisplay(
  exemption: IsolatedDisplayExemption,
  env: IsolatedDisplayEnv = process.env,
  platform: string = process.platform
): boolean {
  if (env[exemption.flag] !== '1') {
    return false
  }
  if (
    platform !== 'linux' ||
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    !env.DISPLAY
  ) {
    throw new Error(exemption.requirement)
  }
  return true
}

/** Presents without focus. Resolves true only once every window is confirmed visible. */
export async function presentOnIsolatedDisplay(
  exemption: IsolatedDisplayExemption,
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<boolean> {
  if (!shouldPresentOnIsolatedDisplay(exemption)) {
    return false
  }
  const visible = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    for (const window of windows) {
      window.showInactive()
    }
    return windows.length > 0 && windows.every((window) => window.isVisible())
  })
  if (!visible) {
    throw new Error(exemption.absent)
  }
  testInfo.annotations.push({ type: exemption.annotation, description: 'isolated-xvfb' })
  return true
}
