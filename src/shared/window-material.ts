/** What sits behind the main window's translucent surfaces: nothing, the desktop, or the blurred desktop. */
export type WindowMaterial = 'off' | 'translucent' | 'blur'

const WINDOW_MATERIAL_ARGUMENT_PREFIX = '--orca-window-material='

export type WindowMaterialSettings = {
  /** Main-window backdrop shown through translucent terminals; creation-time, so changes need a restart. */
  windowMaterial?: WindowMaterial
  /** Legacy switch, read only when `windowMaterial` is unset (see windowMaterialPreference). */
  windowBackgroundBlur?: boolean
  /** Drops modal/backdrop blur and the window material for remote or GPU-less sessions (#20936). */
  reduceVisualEffects?: boolean
}

type WindowMaterialInputs = WindowMaterialSettings & { terminalBackgroundOpacity?: number }

function isWindowMaterial(value: unknown): value is WindowMaterial {
  return value === 'off' || value === 'translucent' || value === 'blur'
}

/** The user's choice. Profiles from before `windowMaterial` carry it in the legacy blur switch,
 *  which never did anything on Linux, so it is not promoted to a transparent window there. */
export function windowMaterialPreference(
  settings: WindowMaterialInputs,
  platform: NodeJS.Platform
): WindowMaterial {
  if (isWindowMaterial(settings.windowMaterial)) {
    return settings.windowMaterial
  }
  return settings.windowBackgroundBlur === true && platform !== 'linux' ? 'blur' : 'off'
}

/** Where the window runs; Windows release strings look like `10.0.22631`. */
export type WindowMaterialHost = { platform: NodeJS.Platform; osRelease: string }

// Why: DWM system backdrops (acrylic) exist from Windows 11 22H2 (build 22621); earlier builds would show black.
const WINDOWS_BACKDROP_MIN_BUILD = 22621

/** Materials each host can render: Windows has no unblurred transparency, Linux compositors own blur. */
export function selectableWindowMaterials(host: WindowMaterialHost): readonly WindowMaterial[] {
  if (host.platform === 'darwin') {
    return ['off', 'translucent', 'blur']
  }
  if (host.platform === 'win32') {
    const build = Number(host.osRelease.split('.')[2])
    return build >= WINDOWS_BACKDROP_MIN_BUILD ? ['off', 'blur'] : ['off']
  }
  return ['off', 'translucent']
}

/** Maps a stored choice onto what this host renders, e.g. a macOS profile opened on Linux. */
export function hostWindowMaterial(
  material: WindowMaterial,
  host: WindowMaterialHost
): WindowMaterial {
  const selectable = selectableWindowMaterials(host)
  if (selectable.includes(material)) {
    return material
  }
  // Why only blur degrades: unblurred see-through never silently becomes a blur effect.
  return material === 'blur' && selectable.includes('translucent') ? 'translucent' : 'off'
}

/**
 * The material the main window is created with. Off unless a surface actually shows through:
 * an occluded vibrancy or alpha window still costs WindowServer composition every frame (#8482).
 */
export function resolveWindowMaterial(
  settings: WindowMaterialInputs | null | undefined,
  host: WindowMaterialHost,
  prefersReducedTransparency: boolean
): WindowMaterial {
  if (!settings || settings.reduceVisualEffects === true || prefersReducedTransparency) {
    return 'off'
  }
  const opacity = settings.terminalBackgroundOpacity
  if (opacity === undefined || !(opacity < 1)) {
    return 'off'
  }
  return hostWindowMaterial(windowMaterialPreference(settings, host.platform), host)
}

export function formatWindowMaterialArgument(material: WindowMaterial): string {
  return `${WINDOW_MATERIAL_ARGUMENT_PREFIX}${material}`
}

/** Read once by the renderer: the material is fixed when the window is created. */
export function parseWindowMaterialArgument(argv: readonly string[]): WindowMaterial {
  const value = argv
    .find((arg) => arg.startsWith(WINDOW_MATERIAL_ARGUMENT_PREFIX))
    ?.slice(WINDOW_MATERIAL_ARGUMENT_PREFIX.length)
  return isWindowMaterial(value) ? value : 'off'
}
