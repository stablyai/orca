// Recipe scripts run locally and inherit Orca's environment. These helpers let a recipe opt into a
// narrower environment (`passEnv`) and let the UI name the credential-like variables a recipe sees.

/** Variables every recipe keeps even with `passEnv`, so shells and provider CLIs still start. */
export const RECIPE_BASE_ENV_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  // Windows: cmd.exe and most CLIs fail to start without these.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
]

const BASE_ENV_NAME_SET = new Set(RECIPE_BASE_ENV_NAMES)

const CREDENTIAL_ENV_NAME_PATTERN =
  /(^|_)(API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|PAT)(_|$)/

const CREDENTIAL_ENV_PREFIXES = ['AWS_', 'AZURE_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_AUTH_']

// Windows env names are case-insensitive; everywhere else they are exact.
function normalizeEnvName(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name
}

/** Names only; a positive match means "show this name in the exposure warning", never its value. */
export function isCredentialLikeEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    CREDENTIAL_ENV_NAME_PATTERN.test(upper) ||
    CREDENTIAL_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  )
}

/** `passEnv` entries are exact names or a prefix ending in `*` (e.g. `AWS_*`). */
export function isRecipeEnvNamePassed(
  name: string,
  passEnv: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!passEnv) {
    return true
  }
  const target = normalizeEnvName(name, platform)
  // On Windows this is case-insensitive so `Path`/`SystemRoot` survive.
  if (BASE_ENV_NAME_SET.has(target) || target.startsWith('LC_')) {
    return true
  }
  return passEnv.some((entry) => {
    const pattern = normalizeEnvName(entry, platform)
    return pattern.endsWith('*') ? target.startsWith(pattern.slice(0, -1)) : target === pattern
  })
}

/** The inherited part of a recipe script's environment. */
export function buildRecipeInheritedEnv(
  source: NodeJS.ProcessEnv,
  passEnv: readonly string[] | undefined,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (!passEnv) {
    return { ...source }
  }
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && isRecipeEnvNamePassed(name, passEnv, platform)) {
      env[name] = value
    }
  }
  return env
}

/** Sorted credential-like names with a non-empty value in `source`. Never returns values. */
export function listCredentialLikeEnvNames(source: NodeJS.ProcessEnv): string[] {
  return Object.entries(source)
    .filter(([name, value]) => Boolean(value) && isCredentialLikeEnvName(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

/** Parse an orca.yaml `passEnv` list. Returns null when the value is malformed. */
export function parseRecipePassEnv(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^[A-Za-z_][A-Za-z0-9_()]*\*?$/.test(entry.trim())) {
      return null
    }
    names.push(entry.trim())
  }
  return [...new Set(names)]
}
