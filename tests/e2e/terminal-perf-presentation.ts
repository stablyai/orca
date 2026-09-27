import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import {
  type IsolatedDisplayEnv,
  presentOnIsolatedDisplay,
  shouldPresentOnIsolatedDisplay
} from './isolated-display-presentation'

const terminalPerfExemption = {
  flag: 'ORCA_E2E_TERMINAL_PERF_XVFB',
  requirement: 'Terminal perf presentation requires an isolated GitHub Actions Xvfb display',
  annotation: 'terminal-perf-presentation',
  absent: 'Terminal perf window was not presented on the isolated display'
} as const

export function shouldPresentTerminalPerfWindow(
  env: IsolatedDisplayEnv = process.env,
  platform: string = process.platform
): boolean {
  return shouldPresentOnIsolatedDisplay(terminalPerfExemption, env, platform)
}

export async function presentTerminalPerfWindow(
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<void> {
  await presentOnIsolatedDisplay(terminalPerfExemption, electronApp, testInfo)
}
