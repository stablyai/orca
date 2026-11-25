// App profiles: one Orca app per profile on macOS.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The marker in a profile's userData. serve and orcad find the profile through it. */
export const APP_PROFILE_MARKER = 'orca-app-profile.json'
export const APP_PROFILES_REGISTRY = 'profiles.json'
/** The Info.plist key that makes a bundle a profile app. */
export const APP_PROFILE_PLIST_ID_KEY = 'OrcaAppProfileId'
/** Info.plist key for a test root. `orca profiles create --pin-root` writes it. */
export const APP_PROFILE_PLIST_ROOT_KEY = 'OrcaAppProfilesRoot'
/** Overrides the folder that holds profiles.json and the profile userData folders. */
export const APP_PROFILES_ROOT_ENV = 'ORCA_PROFILES_ROOT'
/** Overrides the folder that holds the profile apps. */
export const APP_PROFILES_APPS_DIR_ENV = 'ORCA_PROFILES_APPS_DIR'

export type AppProfileEntry = {
  id: string
  name: string
  bundleId: string
  appPath: string
  userDataPath: string
  createdAt: number
}

export type AppProfileRegistry = {
  version: 1
  defaultAppPath: string
  profiles: AppProfileEntry[]
}

export function appProfilesRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[APP_PROFILES_ROOT_ENV] || join(home, 'Library', 'Application Support', 'Orca Profiles')
}

export function appProfilesAppsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[APP_PROFILES_APPS_DIR_ENV] || join(home, 'Applications', 'Orca Profiles')
}

/** The profile id in a userData folder, or null when the folder is not a profile's. */
export function readAppProfileMarker(userDataPath: string): string | null {
  try {
    const marker: unknown = JSON.parse(readFileSync(join(userDataPath, APP_PROFILE_MARKER), 'utf8'))
    const id = marker && typeof marker === 'object' && 'id' in marker ? marker.id : null
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** Writes the marker when it is missing. serve and orcad find the profile only through it. */
export function ensureAppProfileMarker(userDataPath: string, id: string): void {
  const marker = join(userDataPath, APP_PROFILE_MARKER)
  if (!existsSync(marker)) {
    mkdirSync(userDataPath, { recursive: true, mode: 0o700 })
    writeFileSync(marker, `${JSON.stringify({ id })}\n`)
  }
}

function isAppProfileRegistry(value: unknown): value is AppProfileRegistry {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'defaultAppPath' in value &&
    typeof value.defaultAppPath === 'string' &&
    'profiles' in value &&
    Array.isArray(value.profiles)
  )
}

/** profiles.json, or null when it is missing or not a version 1 registry. */
export function readAppProfileRegistry(root: string): AppProfileRegistry | null {
  try {
    const registry: unknown = JSON.parse(readFileSync(join(root, APP_PROFILES_REGISTRY), 'utf8'))
    return isAppProfileRegistry(registry) ? registry : null
  } catch {
    return null
  }
}

/** One `<string>` value of a top-level key in an XML Info.plist. */
export function readPlistString(xml: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
  return match
    ? match[1]
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
    : null
}
