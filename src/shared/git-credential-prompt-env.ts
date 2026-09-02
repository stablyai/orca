import { addWslEnvKeys } from './wsl-env'

const GIT_CONFIG_WSLENV_KEY_RE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/
const GIT_CONFIG_INDEXED_KEY_RE = /^GIT_CONFIG_(?:KEY|VALUE)_(\d+)$/

/** Merge an indexed-config protocol as one atomic environment value. */
export function mergeGitConfigEnvProtocol(
  baseEnv: NodeJS.ProcessEnv,
  overrideEnv: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  const next = { ...baseEnv, ...overrideEnv }
  if (!overrideEnv || !Object.keys(overrideEnv).some((key) => GIT_CONFIG_WSLENV_KEY_RE.test(key))) {
    return next
  }

  // Why: COUNT and its indexed pairs form one protocol; retaining lower-priority
  // indices behind a smaller override count makes an otherwise valid env ambiguous.
  for (const key of Object.keys(next)) {
    if (GIT_CONFIG_WSLENV_KEY_RE.test(key)) {
      delete next[key]
    }
  }
  for (const [key, value] of Object.entries(overrideEnv)) {
    if (GIT_CONFIG_WSLENV_KEY_RE.test(key)) {
      next[key] = value
    }
  }
  return next
}

/** Return the safe append position for Git's indexed-config environment protocol. */
export function readValidGitConfigEnvCount(env: NodeJS.ProcessEnv): number | null {
  const rawCount = env.GIT_CONFIG_COUNT
  const indexedKeys = Object.keys(env).filter((key) => GIT_CONFIG_INDEXED_KEY_RE.test(key))
  if (rawCount === undefined) {
    return indexedKeys.length === 0 ? 0 : null
  }
  if (!/^(?:0|[1-9]\d*)$/.test(rawCount)) {
    return null
  }

  const count = Number(rawCount)
  if (!Number.isSafeInteger(count) || indexedKeys.length !== count * 2) {
    return null
  }
  for (let index = 0; index < count; index++) {
    if (
      typeof env[`GIT_CONFIG_KEY_${index}`] !== 'string' ||
      typeof env[`GIT_CONFIG_VALUE_${index}`] !== 'string'
    ) {
      return null
    }
  }
  const hasDanglingIndex = indexedKeys.some((key) => {
    const match = key.match(GIT_CONFIG_INDEXED_KEY_RE)
    return !match || String(Number(match[1])) !== match[1] || Number(match[1]) >= count
  })
  return hasDanglingIndex ? null : count
}

/** Compose indexed Git config without clobbering caller-provided entries. */
export function appendGitConfigEnv(
  env: NodeJS.ProcessEnv,
  entries: readonly (readonly [key: string, value: string])[]
): NodeJS.ProcessEnv {
  const next = { ...env }
  const base = readValidGitConfigEnvCount(env)
  if (base === null) {
    // Why: ambiguous protocol state may contain caller data at any index, so
    // scalar guards are safer than overwriting it with Orca-owned entries.
    return next
  }
  entries.forEach(([key, value], index) => {
    next[`GIT_CONFIG_KEY_${base + index}`] = key
    next[`GIT_CONFIG_VALUE_${base + index}`] = value
  })
  next.GIT_CONFIG_COUNT = String(base + entries.length)
  return next
}

/**
 * Disable interactive Git credential UI while preserving cached credentials
 * and caller-provided askpass programs.
 */
export function gitCredentialPromptGuardEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const next = appendGitConfigEnv(
    {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: env.GIT_ASKPASS ?? '',
      SSH_ASKPASS: env.SSH_ASKPASS ?? '',
      // Why: GCM can ignore terminal/askpass guards and open its own GUI.
      GCM_INTERACTIVE: 'never'
    },
    // Why: keep the helper so cached credentials continue to work; disable
    // only its interactive fallback.
    [
      ['credential.interactive', 'false'],
      ['credential.guiPrompt', 'false']
    ]
  )
  if (platform === 'win32') {
    // Why: wsl.exe imports only variables registered in WSLENV. Indexed Git
    // config must cross as a complete set or Git rejects the count.
    const configKeys =
      readValidGitConfigEnvCount(next) === null
        ? []
        : Object.keys(next).filter((key) => GIT_CONFIG_WSLENV_KEY_RE.test(key))
    addWslEnvKeys(next, ['GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', ...configKeys])
  }
  return next
}
