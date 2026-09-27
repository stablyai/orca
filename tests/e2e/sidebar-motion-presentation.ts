import type { ElectronApplication, TestInfo } from '@stablyai/playwright-test'
import {
  type IsolatedDisplayEnv,
  presentOnIsolatedDisplay,
  shouldPresentOnIsolatedDisplay
} from './isolated-display-presentation'

// A never-presented Linux window starves requestAnimationFrame once the page stops damaging its
// surface: viz withholds begin frames with reason ThrottleUndrawnFrames. See tests/AGENTS.md.
const sidebarMotionExemption = {
  flag: 'ORCA_E2E_SIDEBAR_MOTION_XVFB',
  requirement: 'Sidebar motion presentation requires an isolated GitHub Actions Xvfb display',
  annotation: 'sidebar-motion-presentation',
  absent: 'Sidebar motion window was not presented on the isolated display'
} as const

export type SidebarMotionPresentation = {
  presented: boolean
  windows: number
  visible: number
}

export function shouldPresentSidebarMotionWindow(
  env: IsolatedDisplayEnv = process.env,
  platform: string = process.platform
): boolean {
  return shouldPresentOnIsolatedDisplay(sidebarMotionExemption, env, platform)
}

export async function presentSidebarMotionWindow(
  electronApp: Pick<ElectronApplication, 'evaluate'>,
  testInfo: Pick<TestInfo, 'annotations'>
): Promise<SidebarMotionPresentation> {
  const presented = await presentOnIsolatedDisplay(sidebarMotionExemption, electronApp, testInfo)
  if (!presented) {
    return { presented: false, windows: 0, visible: 0 }
  }
  // Read separately so the shared guard keeps its boolean contract.
  const counts = await electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    return {
      windows: windows.length,
      visible: windows.filter((window) => window.isVisible()).length
    }
  })
  return { presented: true, ...counts }
}
