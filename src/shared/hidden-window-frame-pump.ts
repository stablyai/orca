/**
 * Windows produces no compositor frame for an idle never-shown window, and main-process
 * webContents.invalidate() does not change that, so CDP Page.captureScreenshot under
 * ORCA_BACKGROUND_LAUNCH=1 waits forever. A one-frame renderer style flip does produce a frame.
 */
const HIDDEN_WINDOW_FRAME_PUMP_ARGUMENT = '--orca-hidden-window-frame-pump'

export const HIDDEN_WINDOW_FRAME_PUMP_STOP_CHANNEL = 'window:hidden-frame-pump-stop'
export const HIDDEN_WINDOW_FRAME_PUMP_INTERVAL_MS = 750

export function shouldPumpHiddenWindowFrames(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): boolean {
  return platform === 'win32' && env.ORCA_BACKGROUND_LAUNCH === '1'
}

export function formatHiddenWindowFramePumpArgument(): string {
  return HIDDEN_WINDOW_FRAME_PUMP_ARGUMENT
}

export function hasHiddenWindowFramePumpArgument(argv: readonly string[]): boolean {
  return argv.includes(HIDDEN_WINDOW_FRAME_PUMP_ARGUMENT)
}
