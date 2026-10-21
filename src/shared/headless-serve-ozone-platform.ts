/**
 * Headless serve renders browser panes in hidden windows on an X display (often its own Xvfb), so
 * it must run Chromium on X11. Chromium picks its platform before Orca's main code runs, from
 * XDG_SESSION_TYPE / WAYLAND_DISPLAY / ELECTRON_OZONE_PLATFORM_HINT, and `app.commandLine` changes
 * cannot move it afterwards. An inherited `XDG_SESSION_TYPE=wayland` with no Wayland compositor
 * makes it exit in platform init (#25400), so the switch must be on the launch argv.
 */
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
