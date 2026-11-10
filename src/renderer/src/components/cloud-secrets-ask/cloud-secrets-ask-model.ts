// What a Cloud workspace still needs from Cloud secrets: the environment's declared names that no scope
// provides for this repo and caller (spec S2, panel section 3). Names only; no value ever reaches here.
import { cloudSecretKind } from '../../../../shared/cloud-secrets/cloud-secret-rules'
import { parseDotenvPaste } from '../../../../shared/cloud-secrets/dotenv-paste'
import type {
  CloudEffectiveSecret,
  CloudSecretScope,
  CloudSecretsCaller,
  CloudSecretsEffective
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import type { HostedEnvironmentListEntry } from '../../../../shared/hosted-sandbox/hosted-environment-wire'

/** `github.com/owner/name`, lower case, from any GitHub remote form (https, ssh, bare owner/name). */
export function githubRepoKey(url: string): string | null {
  const trimmed = url
    .trim()
    .toLowerCase()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const match =
    /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+)$/.exec(trimmed) ??
    /^([^/\s:@]+)\/([^/\s]+)$/.exec(trimmed)
  return match ? `github.com/${match[1]}/${match[2]}` : null
}

/** The org environment that lists this repo; the control plane boots a create from the same one. */
export function environmentForRepo<T extends Pick<HostedEnvironmentListEntry, 'repos'>>(
  environments: readonly T[],
  repoKey: string
): T | null {
  return (
    environments.find((environment) =>
      environment.repos.some((repo) => githubRepoKey(repo.url) === repoKey)
    ) ?? null
  )
}

/**
 * Declared names this caller's workspace won't get. Agent keys are left out: the Agents slice owns
 * those, and a Cloud secret request can't ask for them either.
 */
export function missingSecretNames(
  envVarNames: readonly string[],
  effective: Pick<CloudSecretsEffective, 'secrets'>
): string[] {
  const provided = new Set(effective.secrets.map((secret) => secret.name))
  const seen = new Set<string>()
  const missing: string[] = []
  for (const name of envVarNames) {
    if (provided.has(name) || seen.has(name) || cloudSecretKind(name) === 'agent_key') {
      continue
    }
    seen.add(name)
    missing.push(name)
  }
  return missing
}

/** Scopes a person can save a missing value to, Personal first. Shared only where asked for. */
export function writableScopes(
  caller: Pick<CloudSecretsCaller, 'canWrite'>,
  options: { repo: boolean; shared: boolean }
): CloudSecretScope[] {
  const scopes: CloudSecretScope[] = ['personal']
  if (options.repo && caller.canWrite.repo) {
    scopes.push('repo')
  }
  if (options.shared && caller.canWrite.org) {
    scopes.push('org')
  }
  return scopes
}

/** Owners and admins: anyone who can write the team scope. */
export function isTeamAdmin(caller: Pick<CloudSecretsCaller, 'canWrite'>): boolean {
  return caller.canWrite.org
}

export type CloudSecretsAskData = {
  environmentName: string
  /** Declared names, after dropping agent keys. */
  total: number
  missing: string[]
  caller: CloudSecretsCaller
  /** The environment has been built, so its install script ran without the missing team values. */
  built: boolean
  repoKey: string | null
}

export function cloudSecretsAskData(args: {
  environment: Pick<HostedEnvironmentListEntry, 'name' | 'envVarNames' | 'activeBuildId'>
  effective: CloudSecretsEffective
  repoKey: string | null
}): CloudSecretsAskData {
  const declared = args.environment.envVarNames.filter(
    (name) => cloudSecretKind(name) !== 'agent_key'
  )
  return {
    environmentName: args.environment.name,
    total: new Set(declared).size,
    missing: missingSecretNames(declared, args.effective),
    caller: args.effective.caller,
    built: args.environment.activeBuildId !== null,
    repoKey: args.repoKey
  }
}

/** Effective entries of one kind, sorted by name. */
export function effectiveOfKind(
  effective: Pick<CloudSecretsEffective, 'secrets'>,
  kind: CloudEffectiveSecret['kind']
): CloudEffectiveSecret[] {
  return effective.secrets
    .filter((secret) => secret.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name))
}

const SCOPES: readonly CloudSecretScope[] = ['personal', 'repo', 'org']

/** A Select's string value back as a scope; anything unexpected falls back to Personal. */
export function parseScope(value: string): CloudSecretScope {
  return SCOPES.find((scope) => scope === value) ?? 'personal'
}

/** Fills the missing names from pasted .env text; the text itself is never kept. */
export function applyDotenvPaste(
  text: string,
  missing: readonly string[],
  values: Record<string, string>
): {
  values: Record<string, string>
  summary: { matched: number; count: number; ignored: number }
} {
  const wanted = new Set(missing)
  const entries = parseDotenvPaste(text)
  const next = { ...values }
  const matched = new Set<string>()
  for (const entry of entries) {
    // Later lines win, as in a shell; an earlier duplicate counts as ignored.
    if (wanted.has(entry.name) && (entry.issue === null || entry.issue === 'overridden')) {
      next[entry.name] = entry.value
      matched.add(entry.name)
    }
  }
  return {
    values: next,
    summary: {
      matched: matched.size,
      count: missing.length,
      ignored: entries.length - matched.size
    }
  }
}
