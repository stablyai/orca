// Internal startup setting that picks the layout path; delete with the old path once main owns layout everywhere.
// Each host resolves it once into LAYOUT_OWNER_RESOLVED_ENV before any of its modules evaluate (desktop and
// Electron serve: the index.js banner; orcad: its first import); children inherit it, renderers copy their host.

export type LayoutOwner = 'window' | 'main'

/** The desktop's override, either way; without it the desktop reads LAYOUT_OWNER_FLAG_FILE_NAME in userData. */
export const LAYOUT_OWNER_ENV = 'ORCA_LAYOUT_OWNER'
/** orcad and Electron serve read only this, so a desktop's choice never flips a server. */
export const SERVER_LAYOUT_OWNER_ENV = 'ORCA_SERVER_LAYOUT_OWNER'
/** The host's resolved value; every host recomputes it, so an inherited copy is a parent's. */
export const LAYOUT_OWNER_RESOLVED_ENV = 'ORCA_LAYOUT_OWNER_RESOLVED'
export const LAYOUT_OWNER_FLAG_FILE_NAME = 'layout-owner-mode'
/** Where the desktop banner read the flag from; main compares it with the final userData. */
export const LAYOUT_OWNER_FLAG_DIR_KEY = '__orcaLayoutOwnerFlagDir'
/** Where an Electron renderer finds its main's value: preload copies it from argv. */
export const LAYOUT_OWNER_GLOBAL = '__orcaLayoutOwner'
/** Where the web client finds its serving host's value. */
export const LAYOUT_OWNER_META_NAME = 'orca-layout-owner'

const ARGUMENT_PREFIX = '--orca-layout-owner='

export function parseLayoutOwner(value: unknown): LayoutOwner | null {
  const word = typeof value === 'string' ? value.trim() : ''
  return word === 'main' || word === 'window' ? word : null
}

export function formatLayoutOwnerArgument(owner: LayoutOwner): string {
  return `${ARGUMENT_PREFIX}${owner}`
}

/** A missing or unknown argument is the old path: a renderer must never guess main. */
export function readLayoutOwnerArgument(argv: readonly string[]): {
  owner: LayoutOwner
  problem: string | null
} {
  const argument = argv.find((entry) => entry.startsWith(ARGUMENT_PREFIX))
  if (argument === undefined) {
    return { owner: 'window', problem: 'main passed no layout owner' }
  }
  const owner = parseLayoutOwner(argument.slice(ARGUMENT_PREFIX.length))
  return owner
    ? { owner, problem: null }
    : { owner: 'window', problem: `unknown layout owner ${JSON.stringify(argument)}` }
}

export type LayoutOwnerStartupScope = {
  [LAYOUT_OWNER_GLOBAL]?: unknown
  document?: {
    querySelector(selector: string): { getAttribute(name: string): string | null } | null
  }
  process?: { env?: Record<string, string | undefined> }
}

/** Preload global, then the served meta tag, then the env (hosts' resolved value, or the override in tests). */
export function readStartupLayoutOwner(
  scope: LayoutOwnerStartupScope,
  warn: (message: string) => void
): LayoutOwner {
  const raw = readRawStartupLayoutOwner(scope)
  if (raw === undefined) {
    return 'window'
  }
  const owner = parseLayoutOwner(raw)
  if (!owner) {
    warn(`[layout-owner] unknown layout owner ${JSON.stringify(raw)}; using the window path`)
  }
  return owner ?? 'window'
}

function readRawStartupLayoutOwner(scope: LayoutOwnerStartupScope): unknown {
  if (scope[LAYOUT_OWNER_GLOBAL] !== undefined) {
    return scope[LAYOUT_OWNER_GLOBAL]
  }
  const meta = scope.document?.querySelector(`meta[name="${LAYOUT_OWNER_META_NAME}"]`)
  if (meta) {
    return meta.getAttribute('content') ?? undefined
  }
  const env = scope.process?.env
  return env?.[LAYOUT_OWNER_RESOLVED_ENV] ?? env?.[LAYOUT_OWNER_ENV]
}
