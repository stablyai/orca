import { z } from 'zod'
import { CLAUDE_CONFIG_PROFILE_DIR_ENV } from './claude-profile-routing'

/** A user-owned Claude config folder Orca launches as is; unlike a managed account, Orca never copies settings into it. */
export type ClaudeConfigProfile = {
  id: string
  label: string
  /** Absolute host path used as CLAUDE_CONFIG_DIR. */
  configDir: string
}

export type ClaudeConfigProfileSettings = {
  /** Each profile is its own Claude entry in the agent menu, launched with that CLAUDE_CONFIG_DIR. */
  claudeConfigProfiles?: ClaudeConfigProfile[]
}

export const CLAUDE_CONFIG_PROFILES_MAX = 32
const MAX_LABEL_LENGTH = 64
const MAX_DIR_LENGTH = 4096

/** Env values are not shell-expanded, so `~` or relative folders would name the wrong place. */
export function isClaudeConfigProfileDir(value: string): boolean {
  if (value.length === 0 || value.length > MAX_DIR_LENGTH || /[\0\r\n]/.test(value)) {
    return false
  }
  if (!value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value)) {
    return false
  }
  return !value.split(/[\\/]/).includes('..')
}

const ClaudeConfigProfileSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  configDir: z.string().trim().refine(isClaudeConfigProfileDir)
})

function sameDir(left: string, right: string): boolean {
  const strip = (value: string) => value.replace(/[\\/]+$/, '')
  return strip(left) === strip(right)
}

export function findClaudeConfigProfileByDir(
  profiles: readonly ClaudeConfigProfile[] | undefined,
  configDir: string
): ClaudeConfigProfile | undefined {
  return profiles?.find((profile) => sameDir(profile.configDir, configDir.trim()))
}

/** Drop malformed rows and repeated ids or folders so every menu entry launches a distinct folder. */
export function normalizeClaudeConfigProfiles(value: unknown): ClaudeConfigProfile[] {
  if (!Array.isArray(value)) {
    return []
  }
  const profiles: ClaudeConfigProfile[] = []
  for (const row of value) {
    const parsed = ClaudeConfigProfileSchema.safeParse(row)
    if (
      !parsed.success ||
      profiles.some((profile) => profile.id === parsed.data.id) ||
      findClaudeConfigProfileByDir(profiles, parsed.data.configDir)
    ) {
      continue
    }
    profiles.push(parsed.data)
    if (profiles.length >= CLAUDE_CONFIG_PROFILES_MAX) {
      break
    }
  }
  return profiles
}

export function claudeConfigProfileLaunchEnv(profile: ClaudeConfigProfile): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: profile.configDir,
    [CLAUDE_CONFIG_PROFILE_DIR_ENV]: profile.configDir
  }
}

/** The profile folder a launch env names, or null when the launch should follow account routing. */
export function claudeConfigProfileDirFromEnv(
  env: Readonly<Record<string, string | undefined>> | undefined
): string | null {
  const dir = env?.[CLAUDE_CONFIG_PROFILE_DIR_ENV]
  return dir && dir === env?.CLAUDE_CONFIG_DIR && isClaudeConfigProfileDir(dir) ? dir : null
}
