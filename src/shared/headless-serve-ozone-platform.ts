/** Headless serve needs X11 for hidden windows/Xvfb. Chromium selects its platform before main, so app.commandLine is too late.
 * Put X11 on launch argv: inherited Wayland variables without a compositor otherwise crash platform initialization (#25400). */
export const HEADLESS_SERVE_OZONE_PLATFORM_SWITCH = '--ozone-platform=x11'

/** True when argv already names a platform; a `--ozone-platform-hint` is only a preference. */
export function hasExplicitOzonePlatform(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === '--') {
      return false
    }
    if (arg === '--ozone-platform' || arg.startsWith('--ozone-platform=')) {
      return true
    }
  }
  return false
}

/** Switches for an Electron serve launch on `platform`. */
export function headlessServeOzonePlatformSwitches(platform: NodeJS.Platform): string[] {
  return platform === 'linux' ? [HEADLESS_SERVE_OZONE_PLATFORM_SWITCH] : []
}
