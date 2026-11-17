import * as z from 'zod'
import { HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS } from '../hosted-sandbox/hosted-environment-wire'

// `orca cloud env ...`: the agent-facing surface. It can read the environment, replace the install
// script and run builds; repos, env var names and secrets are deliberately not reachable here.

/** Environment id (`env_...`) or name; omitted picks the org's only (or first) environment. */
const EnvSelector = z.string().trim().min(1).max(128).optional()

export const CloudEnvironmentShowParams = z.object({
  env: EnvSelector,
  refresh: z.boolean().optional()
})

export const CloudEnvironmentSelectParams = z.object({
  env: EnvSelector
})

export const CloudEnvironmentSetInstallScriptParams = z.object({
  env: EnvSelector,
  script: z.string().max(HOSTED_ENVIRONMENT_MAX_INSTALL_SCRIPT_CHARS),
  expectedRevision: z.number().int().positive().optional()
})

export const CloudEnvironmentFollowBuildParams = z.object({
  env: EnvSelector,
  /** Build id (`bld_...`) or build number. */
  build: z.string().trim().min(1).max(64),
  cursor: z.number().int().nonnegative().optional(),
  waitMs: z.number().int().min(0).max(20_000).optional()
})
