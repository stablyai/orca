import type * as Monaco from 'monaco-editor'
import type { editor, languages, Position } from 'monaco-editor'
import {
  openImportFileTarget,
  resolveImportLinkTarget,
  type ResolvedImportLinkTarget
} from './import-link-target-resolution'
import { findImportSpecifierLinkAt, type ImportSpecifierLink } from './import-specifier-links'

export const OPEN_IMPORT_TARGET_COMMAND_ID = 'orca.openImportTarget'

export type ImportHoverSource = {
  filePath: string
  fileId: string
  worktreeId: string | undefined
}

type ImportHoverContext = {
  getLinks: () => ImportSpecifierLink[]
  getSource: () => ImportHoverSource
}

type ImportHoverRegistration = { context: ImportHoverContext }

const hoverRegistrationsByModel = new Map<string, Set<ImportHoverRegistration>>()

function clearImportHoverResolutionCache(modelKey: string): void {
  const cachePrefix = `${modelKey}\0`
  for (const cacheKey of resolutionCache.keys()) {
    if (cacheKey.startsWith(cachePrefix)) {
      resolutionCache.delete(cacheKey)
    }
  }
}

export function registerImportHoverContext(
  modelKey: string,
  context: ImportHoverContext
): () => void {
  const registration = { context }
  const registrations = hoverRegistrationsByModel.get(modelKey) ?? new Set()
  registrations.add(registration)
  hoverRegistrationsByModel.set(modelKey, registrations)
  let registered = true
  return () => {
    if (!registered) {
      return
    }
    registered = false
    registrations.delete(registration)
    if (registrations.size === 0 && hoverRegistrationsByModel.get(modelKey) === registrations) {
      hoverRegistrationsByModel.delete(modelKey)
      clearImportHoverResolutionCache(modelKey)
    }
  }
}

type CachedResolution = { resolvedAtMs: number; target: Promise<ResolvedImportLinkTarget | null> }

const resolutionCache = new Map<string, CachedResolution>()
const RESOLUTION_CACHE_TTL_MS = 30_000
export const IMPORT_HOVER_RESOLUTION_CACHE_MAX = 256

// Hover can fire repeatedly while the mouse rests on a symbol; cache the
// filesystem probes so the card does not re-stat on every provider call.
export function resolveImportHoverTargetWithCache(
  modelKey: string,
  link: ImportSpecifierLink,
  source: ImportHoverSource,
  resolve: typeof resolveImportLinkTarget = resolveImportLinkTarget
): Promise<ResolvedImportLinkTarget | null> {
  const cacheKey = `${modelKey}\0${link.specifier}`
  const cached = resolutionCache.get(cacheKey)
  const now = Date.now()
  if (cached && now - cached.resolvedAtMs < RESOLUTION_CACHE_TTL_MS) {
    return cached.target
  }
  resolutionCache.delete(cacheKey)
  const target = resolve(link, source)
  resolutionCache.set(cacheKey, { resolvedAtMs: now, target })
  while (resolutionCache.size > IMPORT_HOVER_RESOLUTION_CACHE_MAX) {
    const oldestKey = resolutionCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    resolutionCache.delete(oldestKey)
  }
  return target
}

type OpenImportTargetCommandArgs = {
  targetPath: string
  worktreeId: string
  fileId: string
}

export function buildImportHoverCommandUri(
  target: ResolvedImportLinkTarget,
  source: Pick<ImportHoverSource, 'fileId' | 'worktreeId'>
): string {
  const args: OpenImportTargetCommandArgs = {
    targetPath: target.targetPath,
    worktreeId: source.worktreeId ?? '',
    fileId: source.fileId
  }
  return `command:${OPEN_IMPORT_TARGET_COMMAND_ID}?${encodeURIComponent(JSON.stringify(args))}`
}

const MARKDOWN_LINK_LABEL_DELIMITERS = new Set(['\\', '[', ']', '(', ')'])

function escapeMarkdownLinkLabel(label: string): string {
  return Array.from(label, (character) =>
    MARKDOWN_LINK_LABEL_DELIMITERS.has(character) ? `\\${character}` : character
  ).join('')
}

export async function provideImportLinkHover(
  model: Pick<editor.ITextModel, 'uri'>,
  position: Pick<Position, 'lineNumber' | 'column'>,
  resolve: typeof resolveImportHoverTargetWithCache = resolveImportHoverTargetWithCache
): Promise<languages.Hover | null> {
  const modelKey = model.uri.toString()
  const context = hoverRegistrationsByModel.get(modelKey)?.values().next().value?.context
  if (!context) {
    return null
  }
  const link = findImportSpecifierLinkAt(context.getLinks(), position)
  if (!link) {
    return null
  }
  const source = context.getSource()
  const target = await resolve(modelKey, link, source)
  if (!target) {
    return null
  }
  return {
    range: link.range,
    contents: [
      {
        isTrusted: { enabledCommands: [OPEN_IMPORT_TARGET_COMMAND_ID] },
        value: `[↗ ${escapeMarkdownLinkLabel(target.targetLabel)}](${buildImportHoverCommandUri(target, source)})`
      }
    ]
  }
}

let providerInstalled = false

export function ensureImportHoverLinkProvider(monaco: typeof Monaco): void {
  if (providerInstalled) {
    return
  }
  providerInstalled = true
  monaco.editor.registerCommand(
    OPEN_IMPORT_TARGET_COMMAND_ID,
    (_accessor, args: OpenImportTargetCommandArgs | undefined) => {
      if (!args?.targetPath) {
        return
      }
      openImportFileTarget(args.targetPath, {
        worktreeId: args.worktreeId || undefined,
        fileId: args.fileId ?? ''
      })
    }
  )
  for (const languageId of ['typescript', 'javascript']) {
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: (model, position) => provideImportLinkHover(model, position)
    })
  }
}
