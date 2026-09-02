import { parseDocument } from 'yaml'
import type {
  OrcaDefaultTabTemplate,
  OrcaHooks,
  OrcaVmRecipe,
  OrcaVmRecipeDiagnostic
} from './orca-yaml-hook-types'
import {
  isOrcaYamlFieldWithinLimit,
  isOrcaYamlTextWithinLimit,
  MAX_ORCA_YAML_ALIAS_COUNT,
  MAX_ORCA_YAML_COLLECTION_ENTRIES
} from './orca-yaml-file-limit'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isOrcaYamlFieldWithinLimit(value)) {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed || undefined
}

const DEFAULT_TAB_COLOR_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
export const ORCA_VM_RECIPE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const ORCA_VM_RECIPE_ID_RULE =
  'Use 1-64 lowercase letters, numbers, dots, underscores, or hyphens, starting with a letter or number.'

// Why: bound the work one repo file can request; entries beyond this are ignored.
const MAX_SHARED_DIRECTORIES = 100

/** Normalize `worktree.sharedDirectories` into deduped repo-root-relative paths.
 *  `\` becomes `/`, a `./` prefix and trailing `/` are stripped. Absolute paths,
 *  `..` traversal and `.git` are dropped here so callers get only safe entries.
 *
 *  Entries that would still need collapsing (`apps/./web`) are dropped rather
 *  than rewritten: `resolve()` collapses them when the symlink is created, but
 *  Git reports the collapsed path, so every later comparison against the stored
 *  entry would miss and the link would look like permanent untracked work. */
function normalizeSharedDirectories(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  for (const entry of value.slice(0, MAX_SHARED_DIRECTORIES)) {
    const raw = asTrimmedString(entry)
    if (!raw) {
      continue
    }
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const segments = normalized.split('/')
    if (
      !normalized ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      segments.includes('..') ||
      segments.includes('.') ||
      segments.includes('') ||
      segments.includes('.git')
    ) {
      continue
    }
    seen.add(normalized)
  }
  return Array.from(seen)
}

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Why: pass the name regex but mutate object internals when assigned as keys.
const UNSAFE_ENV_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Why: the trust content is line-oriented; a control char in a reviewed value forges structure.
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

function normalizeTabEnv(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) {
    return undefined
  }
  const env: Record<string, string> = Object.create(null)
  let accepted = 0
  for (const [key, raw] of Object.entries(record)) {
    // Why: cap accepted entries, not raw ones — invalid entries must not eat the budget.
    if (accepted >= MAX_ORCA_YAML_COLLECTION_ENTRIES) {
      break
    }
    if (
      !ENV_VAR_NAME_RE.test(key) ||
      UNSAFE_ENV_KEYS.has(key) ||
      typeof raw !== 'string' ||
      // Why: the trust content is line-oriented, so a CR/LF (or NUL) in a value forges extra
      // entries — `FOO: "a\nPATH=evil"` would hash identically to a real `PATH: evil`.
      hasControlCharacter(raw) ||
      !isOrcaYamlFieldWithinLimit(key) ||
      !isOrcaYamlFieldWithinLimit(raw)
    ) {
      continue
    }
    env[key] = raw
    accepted += 1
  }
  return accepted > 0 ? { ...env } : undefined
}

function normalizeDefaultTabs(value: unknown): OrcaDefaultTabTemplate[] {
  if (!Array.isArray(value) || value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return []
  }

  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) {
        return null
      }
      // Why: the title sits on the trust content's header line, so a newline in it forges env lines.
      const rawTitle = asTrimmedString(record.title)
      const title = rawTitle && !hasControlCharacter(rawTitle) ? rawTitle : undefined
      const command = asTrimmedString(record.command)
      const color = asTrimmedString(record.color)
      const normalizedColor = color && DEFAULT_TAB_COLOR_RE.test(color) ? color : undefined
      const env = normalizeTabEnv(record.env)
      if (!title && !command && !normalizedColor && !env) {
        return null
      }
      return {
        ...(title ? { title } : {}),
        ...(normalizedColor ? { color: normalizedColor } : {}),
        ...(command ? { command } : {}),
        ...(env ? { env } : {})
      }
    })
    .filter((entry): entry is OrcaDefaultTabTemplate => entry !== null)
}

type VmRecipeParseResult = {
  recipes: OrcaVmRecipe[]
  diagnostics: OrcaVmRecipeDiagnostic[]
}

function normalizeVmRecipes(value: unknown): VmRecipeParseResult {
  const diagnostics: OrcaVmRecipeDiagnostic[] = []
  if (!Array.isArray(value)) {
    return { recipes: [], diagnostics }
  }
  if (value.length > MAX_ORCA_YAML_COLLECTION_ENTRIES) {
    return {
      recipes: [],
      diagnostics: [
        {
          index: MAX_ORCA_YAML_COLLECTION_ENTRIES,
          message: `At most ${MAX_ORCA_YAML_COLLECTION_ENTRIES} environment recipes are supported.`
        }
      ]
    }
  }

  const seenIds = new Set<string>()
  const recipes = value
    .map((entry, index) => {
      const record = asRecord(entry)
      if (!record) {
        diagnostics.push({
          index,
          message: 'Recipe entry must be a mapping.'
        })
        return null
      }
      const id = asTrimmedString(record.id)
      const name = asTrimmedString(record.name)
      const create = asTrimmedString(record.create) ?? asTrimmedString(record.command)
      if (!id) {
        diagnostics.push({ index, field: 'id', message: 'Recipe id is required.' })
        return null
      }
      if (!ORCA_VM_RECIPE_ID_PATTERN.test(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Invalid recipe id "${id}". ${ORCA_VM_RECIPE_ID_RULE}`
        })
        return null
      }
      if (seenIds.has(id)) {
        diagnostics.push({
          index,
          field: 'id',
          message: `Duplicate recipe id "${id}". Recipe ids must be unique.`
        })
        return null
      }
      if (!name) {
        diagnostics.push({ index, field: 'name', message: `Recipe "${id}" is missing name.` })
        return null
      }
      if (!create) {
        diagnostics.push({ index, field: 'create', message: `Recipe "${id}" is missing create.` })
        return null
      }
      seenIds.add(id)
      const description = asTrimmedString(record.description)
      const checkoutMode = asTrimmedString(record.checkoutMode)
      if (checkoutMode && checkoutMode !== 'orca-worktree' && checkoutMode !== 'provisioned-root') {
        diagnostics.push({
          index,
          field: 'checkoutMode',
          message: `Recipe "${id}" checkoutMode must be "orca-worktree" or "provisioned-root".`
        })
        return null
      }
      const suspend = asTrimmedString(record.suspend)
      const resume = asTrimmedString(record.resume)
      const destroyValue = asTrimmedString(record.destroy) ?? asTrimmedString(record.cleanup)
      const destroyDisabled = destroyValue === 'none'
      return {
        id,
        name,
        create,
        ...(checkoutMode ? { checkoutMode } : {}),
        ...(description ? { description } : {}),
        ...(suspend ? { suspend } : {}),
        ...(resume ? { resume } : {}),
        ...(destroyValue && !destroyDisabled ? { destroy: destroyValue } : {}),
        ...(destroyDisabled ? { destroyDisabled: true } : {})
      }
    })
    .filter((entry): entry is OrcaVmRecipe => entry !== null)
  return { recipes, diagnostics }
}

/**
 * Parse the supported project defaults from `orca.yaml`.
 */
export function parseOrcaYaml(content: string): OrcaHooks | null {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return null
  }

  let root: unknown
  try {
    const document = parseDocument(content, {
      keepSourceTokens: false,
      logLevel: 'silent',
      prettyErrors: false,
      uniqueKeys: true
    })
    if (document.errors.length > 0) {
      return null
    }
    root = document.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return null
  }

  const record = asRecord(root)
  if (!record) {
    return null
  }

  const scriptsRecord = asRecord(record.scripts)
  const setup = scriptsRecord ? asTrimmedString(scriptsRecord.setup) : undefined
  const archive = scriptsRecord ? asTrimmedString(scriptsRecord.archive) : undefined
  const setupAgentStartupPolicy =
    record.setupAgentStartupPolicy === 'start-immediately' ||
    record.setupAgentStartupPolicy === 'wait-for-setup'
      ? record.setupAgentStartupPolicy
      : undefined
  const issueCommand = asTrimmedString(record.issueCommand)
  const defaultTabs = normalizeDefaultTabs(record.defaultTabs)
  const environmentRecipeParse = normalizeVmRecipes(record.environmentRecipes)
  const environmentRecipes = environmentRecipeParse.recipes
  const environmentRecipeDiagnostics = environmentRecipeParse.diagnostics
  const worktreeRecord = asRecord(record.worktree)
  const sharedDirectories = worktreeRecord
    ? normalizeSharedDirectories(worktreeRecord.sharedDirectories)
    : []

  if (
    !setup &&
    !archive &&
    !issueCommand &&
    !setupAgentStartupPolicy &&
    defaultTabs.length === 0 &&
    environmentRecipes.length === 0 &&
    environmentRecipeDiagnostics.length === 0 &&
    sharedDirectories.length === 0
  ) {
    return null
  }

  return {
    scripts: {
      ...(setup ? { setup } : {}),
      ...(archive ? { archive } : {})
    },
    ...(setupAgentStartupPolicy ? { setupAgentStartupPolicy } : {}),
    ...(issueCommand ? { issueCommand } : {}),
    ...(defaultTabs.length > 0 ? { defaultTabs } : {}),
    ...(environmentRecipes.length > 0 ? { environmentRecipes } : {}),
    ...(environmentRecipeDiagnostics.length > 0 ? { environmentRecipeDiagnostics } : {}),
    ...(sharedDirectories.length > 0 ? { worktree: { sharedDirectories } } : {})
  }
}
