// electron-updater compares a manifest's `minimumSystemVersion` with os.release(), the Darwin version.
// Darwin minors drift from macOS minors (12.6 and 12.7 both report Darwin 21.6), so each minor floor
// needs a verified entry; truncating 15.4 to 24.0.0 would offer the update to macOS 15.0.
const MINOR_FLOOR_DARWIN_VERSIONS: Readonly<Record<string, string>> = {
  // 13.3.x runs Darwin 22.4.0; 13.4 and 13.4.1 run 22.5.0.
  '13.4': '22.5.0'
}

// macOS 11-15 run Darwin 20-24; macOS 26 runs Darwin 25.
function darwinMajorForMacosMajor(macosMajor: number): number | null {
  if (macosMajor >= 11 && macosMajor <= 15) {
    return macosMajor + 9
  }
  return macosMajor >= 26 ? macosMajor - 1 : null
}

function macosMajorForDarwinMajor(darwinMajor: number): number | null {
  if (darwinMajor < 20) {
    return null
  }
  return darwinMajor <= 24 ? darwinMajor - 9 : darwinMajor + 1
}

/** The exact Darwin version for a macOS floor; throws when the floor has no verified mapping. */
export function darwinVersionForMacos(macosVersion: string): string {
  const trimmed = macosVersion.trim()
  const minorFloor = MINOR_FLOOR_DARWIN_VERSIONS[trimmed]
  if (minorFloor) {
    return minorFloor
  }
  const match = /^(\d+)(?:\.0){0,2}$/.exec(trimmed)
  const darwinMajor = match ? darwinMajorForMacosMajor(Number.parseInt(match[1], 10)) : null
  if (darwinMajor === null) {
    throw new Error(
      `LSMinimumSystemVersion ${macosVersion} has no exact Darwin floor; add a verified mapping before shipping it`
    )
  }
  return `${darwinMajor}.0.0`
}

/** The macOS version a manifest's parsed Darwin floor stands for, e.g. [22, 5, 0] -> 13.4. */
export function macosVersionForDarwinFloor(darwinParts: readonly number[]): string | null {
  const [major = 0, minor = 0, patch = 0] = darwinParts
  const darwinVersion = `${major}.${minor}.${patch}`
  const minorFloor = Object.entries(MINOR_FLOOR_DARWIN_VERSIONS).find(
    ([, darwin]) => darwin === darwinVersion
  )
  if (minorFloor) {
    return minorFloor[0]
  }
  const macosMajor = macosMajorForDarwinMajor(major)
  return macosMajor === null ? null : String(macosMajor)
}
