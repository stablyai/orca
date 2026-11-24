import { parseDocument } from 'yaml'
import { hashOrcaHookContent } from '../../hashing/orca-hook-content-hash'
import { isOrcaYamlConversionWithinLimit } from '../../workspace-setup/orca-yaml-merge-expansion'
import {
  isOrcaYamlTextWithinLimit,
  MAX_ORCA_YAML_ALIAS_COUNT
} from '../../workspace-setup/orca-yaml-file-limit'
import {
  DEFAULT_WORKTREE_PROVIDER_TIMEOUT_SECONDS,
  MAX_WORKTREE_PROVIDER_ARG_LENGTH,
  MAX_WORKTREE_PROVIDER_ARGV_LENGTH,
  MAX_WORKTREE_PROVIDER_CONFIG_COUNT,
  MAX_WORKTREE_PROVIDER_TIMEOUT_SECONDS,
  WORKTREE_PROVIDER_NAME_PATTERN,
  WORKTREE_PROVIDER_NAME_RULE,
  type WorktreeProviderCommand,
  type WorktreeProviderConfig,
  type WorktreeProviderDiagnostic,
  type WorktreeProviderSource,
  type WorktreeProviderWorkingDirectory
} from './worktree-provider-types'

export type ParsedWorktreeProviders = {
  providers: Map<string, WorktreeProviderConfig>
  diagnostics: WorktreeProviderDiagnostic[]
}

const PROVIDER_KEYS = new Set([
  'claim',
  'release',
  'status',
  'setup',
  'timeoutSeconds',
  'workingDirectory'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above proves a plain object.
  return value as Record<string, unknown>
}

function normalizeCommand(value: unknown): WorktreeProviderCommand | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_WORKTREE_PROVIDER_ARGV_LENGTH
  ) {
    return null
  }
  const args: string[] = []
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_WORKTREE_PROVIDER_ARG_LENGTH ||
      entry.includes('\u0000')
    ) {
      return null
    }
    args.push(entry)
  }
  return args
}

function normalizeTimeout(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_WORKTREE_PROVIDER_TIMEOUT_SECONDS
    ? value
    : undefined
}

function normalizeWorkingDirectory(value: unknown): WorktreeProviderWorkingDirectory | undefined {
  return value === 'repo' || value === 'worktree' ? value : undefined
}

function parseProviderConfig(
  name: string,
  value: unknown,
  source: WorktreeProviderSource,
  filePath: string
): { config: WorktreeProviderConfig | null; diagnostics: WorktreeProviderDiagnostic[] } {
  const diagnostics: WorktreeProviderDiagnostic[] = []
  const record = asRecord(value)
  if (!record) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message: 'Provider must be a mapping.'
    })
    return { config: null, diagnostics }
  }
  const claim = normalizeCommand(record.claim)
  const release = normalizeCommand(record.release)
  if (!claim) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message:
        'claim must be a non-empty argv array of non-empty strings (max 64 arguments, 4096 characters each).'
    })
  }
  if (!release) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message:
        'release must be a non-empty argv array of non-empty strings (max 64 arguments, 4096 characters each).'
    })
  }
  for (const key of Object.keys(record)) {
    if (!PROVIDER_KEYS.has(key)) {
      diagnostics.push({
        source,
        path: filePath,
        provider: name,
        message: `Unknown provider key "${key}".`
      })
    }
  }
  if (!claim || !release) {
    return { config: null, diagnostics }
  }
  const status = record.status === undefined ? undefined : normalizeCommand(record.status)
  const setup = record.setup === undefined ? undefined : normalizeCommand(record.setup)
  if (record.status !== undefined && !status) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message: 'status must be a non-empty argv array of non-empty strings.'
    })
  }
  if (record.setup !== undefined && !setup) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message: 'setup must be a non-empty argv array of non-empty strings.'
    })
  }
  const timeoutSeconds = normalizeTimeout(record.timeoutSeconds)
  if (record.timeoutSeconds !== undefined && timeoutSeconds === undefined) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message: `timeoutSeconds must be an integer from 1 to ${MAX_WORKTREE_PROVIDER_TIMEOUT_SECONDS}.`
    })
  }
  const workingDirectory = normalizeWorkingDirectory(record.workingDirectory)
  if (record.workingDirectory !== undefined && workingDirectory === undefined) {
    diagnostics.push({
      source,
      path: filePath,
      provider: name,
      message: 'workingDirectory must be "repo" or "worktree".'
    })
  }
  return {
    config: {
      claim,
      release,
      ...(status ? { status } : {}),
      ...(setup ? { setup } : {}),
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(workingDirectory ? { workingDirectory } : {})
    },
    diagnostics
  }
}

/** Parse the `providers:` mapping from a user config file or a repo orca.yaml. Never executes anything. */
export function parseWorktreeProviders(
  content: string,
  source: WorktreeProviderSource,
  filePath: string
): ParsedWorktreeProviders {
  const diagnostics: WorktreeProviderDiagnostic[] = []
  if (!isOrcaYamlTextWithinLimit(content)) {
    return {
      providers: new Map(),
      diagnostics: [{ source, path: filePath, message: 'Provider config is too large.' }]
    }
  }
  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      merge: true,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0 || !isOrcaYamlConversionWithinLimit(document)) {
      return {
        providers: new Map(),
        diagnostics: [{ source, path: filePath, message: 'Provider config is not valid YAML.' }]
      }
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return {
      providers: new Map(),
      diagnostics: [{ source, path: filePath, message: 'Provider config is not valid YAML.' }]
    }
  }
  const record = asRecord(root)
  if (!record) {
    return {
      providers: new Map(),
      diagnostics: [{ source, path: filePath, message: 'Provider config must be a mapping.' }]
    }
  }
  const providersRecord = asRecord(record.providers)
  if (!providersRecord) {
    if (record.providers === undefined) {
      return { providers: new Map(), diagnostics }
    }
    return {
      providers: new Map(),
      diagnostics: [
        {
          source,
          path: filePath,
          message: 'providers must be a mapping of provider names to configs.'
        }
      ]
    }
  }
  const entries = Object.entries(providersRecord)
  if (entries.length > MAX_WORKTREE_PROVIDER_CONFIG_COUNT) {
    return {
      providers: new Map(),
      diagnostics: [
        {
          source,
          path: filePath,
          message: `At most ${MAX_WORKTREE_PROVIDER_CONFIG_COUNT} providers are supported.`
        }
      ]
    }
  }
  const providers = new Map<string, WorktreeProviderConfig>()
  for (const [name, value] of entries) {
    if (!WORKTREE_PROVIDER_NAME_PATTERN.test(name)) {
      diagnostics.push({
        source,
        path: filePath,
        provider: name,
        message: `Invalid provider name "${name}". ${WORKTREE_PROVIDER_NAME_RULE}`
      })
      continue
    }
    const parsed = parseProviderConfig(name, value, source, filePath)
    diagnostics.push(...parsed.diagnostics)
    if (parsed.config) {
      providers.set(name, parsed.config)
    }
  }
  return { providers, diagnostics }
}

function orderedProviderConfig(config: WorktreeProviderConfig): Record<string, unknown> {
  return {
    claim: config.claim,
    release: config.release,
    ...(config.status ? { status: config.status } : {}),
    ...(config.setup ? { setup: config.setup } : {}),
    ...(config.timeoutSeconds !== undefined ? { timeoutSeconds: config.timeoutSeconds } : {}),
    ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {})
  }
}

/** Stable serialization: sorted provider names and fixed field order. */
export function canonicalWorktreeProviderConfig(
  providers: ReadonlyMap<string, WorktreeProviderConfig>
): string {
  const ordered: Record<string, unknown> = {}
  for (const name of [...providers.keys()].sort()) {
    const config = providers.get(name)
    if (config) {
      ordered[name] = orderedProviderConfig(config)
    }
  }
  return JSON.stringify(ordered)
}

export function worktreeProviderConfigHash(
  providers: ReadonlyMap<string, WorktreeProviderConfig>
): string {
  return hashOrcaHookContent(canonicalWorktreeProviderConfig(providers))
}

export function worktreeProviderNameConflicts(
  userProviders: ReadonlyMap<string, unknown>,
  repoProviders: ReadonlyMap<string, unknown>
): string[] {
  return [...userProviders.keys()].filter((name) => repoProviders.has(name)).sort()
}

export function providerTimeoutSeconds(config: WorktreeProviderConfig): number {
  return config.timeoutSeconds ?? DEFAULT_WORKTREE_PROVIDER_TIMEOUT_SECONDS
}

export function providerWorkingDirectory(
  config: WorktreeProviderConfig
): WorktreeProviderWorkingDirectory {
  return config.workingDirectory ?? 'repo'
}
