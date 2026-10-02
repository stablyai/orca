import { statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { AgentSkillProviderRootOverrides } from './agent-skill-scan-roots'

/**
 * The env vars that relocate an agent's skills root on the host running this process.
 *
 * Shared because the `orca` CLI has to reach the same verdict as the app about which
 * roots `npx skills update` writes into (`skill-linked-root-deletion.ts`); a CLI that
 * read the default paths while the user had `CLAUDE_CONFIG_DIR` set would judge a folder
 * nothing writes to. The WSL probes that need a distro stay in `main/skills`.
 */

const PROVIDER_ROOT_MAX_LENGTH = 32_768

export function normalizedAgentSkillProviderRoot(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (
    !candidate ||
    candidate.length > PROVIDER_ROOT_MAX_LENGTH ||
    candidate.includes('\0') ||
    !isAbsolute(candidate)
  ) {
    return null
  }
  return resolve(candidate)
}

export function resolveEnvironmentSkillProviderRoots(
  env: NodeJS.ProcessEnv = process.env
): AgentSkillProviderRootOverrides {
  const claudeConfig = normalizedAgentSkillProviderRoot(env.CLAUDE_CONFIG_DIR)
  const grokHome = normalizedAgentSkillProviderRoot(env.GROK_HOME)
  return {
    ...(claudeConfig ? { claude: join(claudeConfig, 'skills') } : {}),
    ...(grokHome ? { grok: join(grokHome, 'skills') } : {})
  }
}

// Why: `HERMES_HOME` relocates a whole Hermes profile tree (`hermes -p coder`),
// and the rest of Orca already treats it as authoritative. Hermes is not an
// install provider, so it stays out of the provider root overrides.
export function resolveEnvironmentHermesSkillsRoot(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const hermesHome = normalizedAgentSkillProviderRoot(env.HERMES_HOME)
  return hermesHome ? join(hermesHome, 'skills') : null
}

function isExistingDirectory(candidate: string): boolean {
  return statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true
}

/**
 * The Hermes home when `HERMES_HOME` is unset. Windows installs land in
 * `%LOCALAPPDATA%\hermes`, not a dotfolder in the user profile, so the POSIX
 * `~/.hermes` default discovers nothing there. The dotfolder still wins on
 * Windows when it exists and the LOCALAPPDATA tree does not, which is the
 * pre-LOCALAPPDATA install Hermes itself keeps honouring rather than orphaning.
 */
export function resolveDefaultHermesSkillsRoot(input: {
  homeDir: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  directoryExists?: (candidate: string) => boolean
}): string {
  const dotfolderHome = join(input.homeDir, '.hermes')
  if ((input.platform ?? process.platform) !== 'win32') {
    return join(dotfolderHome, 'skills')
  }
  const localAppData = normalizedAgentSkillProviderRoot((input.env ?? process.env).LOCALAPPDATA)
  if (!localAppData) {
    return join(dotfolderHome, 'skills')
  }
  const localAppDataHome = join(localAppData, 'hermes')
  const directoryExists = input.directoryExists ?? isExistingDirectory
  return !directoryExists(localAppDataHome) && directoryExists(dotfolderHome)
    ? join(dotfolderHome, 'skills')
    : join(localAppDataHome, 'skills')
}

export function withClaudeSkillProviderRoot(
  roots: AgentSkillProviderRootOverrides,
  claudeConfigDirectory: string | null | undefined
): AgentSkillProviderRootOverrides {
  const configDirectory = normalizedAgentSkillProviderRoot(claudeConfigDirectory ?? undefined)
  return configDirectory ? { ...roots, claude: join(configDirectory, 'skills') } : roots
}
