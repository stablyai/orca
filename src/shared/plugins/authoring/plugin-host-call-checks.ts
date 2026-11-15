import type { PluginSurface } from '../frames/plugin-protocol'
import type { PluginManifest } from '../manifest/plugin-manifest'
import { satisfiesOrcaEngineRange } from '../manifest/plugin-manifest-engine-range'
import { PLUGIN_HOST_API_MAJOR } from '../workers/plugin-host-api-major'
import {
  getPluginHostMethodSpec,
  PLUGIN_HOST_API_MINOR,
  PLUGIN_HOST_METHOD_NAMES
} from '../workers/plugin-host-api'
import { PLUGIN_HOST_HAS_SINCE, pluginHostMethodRelease } from '../workers/plugin-host-api-releases'
import type { PluginArtifactTextReader } from './plugin-strict-artifact-checks'

// Why bounded: a plugin ships its bundle plus a few chunks; anything past this is not host code.
const MAX_SCANNED_FILES = 64
const MAX_SCANNED_CHARS = 32 * 1024 * 1024
const IMPORT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.jsx', '/index.js']

// Why literals only: bundlers keep `orca.host.call('x.y')` names as strings, so this sees them.
const HOST_CALL = /\.(call|has)\(\s*(['"`])([A-Za-z]\w*(?:\.\w+)+)\2/g
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"](\.{1,2}\/[^'"\s]+)['"]/g
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi

const HOST_NAMESPACES = new Set(PLUGIN_HOST_METHOD_NAMES.map((name) => name.split('.')[0]))

const SURFACE_LABELS: Record<PluginSurface, string> = {
  worker: 'the worker',
  panel: 'panels',
  editor: 'custom editors'
}

type HostCall = { name: string; file: string; surface: PluginSurface }

/** Resolves a relative reference against a plugin file; null when it leaves the plugin. */
function resolveInPlugin(from: string, reference: string): string | null {
  const parts = from.split('/').slice(0, -1)
  for (const part of reference.split(/[?#]/)[0]!.split('/')) {
    if (part === '..') {
      if (parts.length === 0) {
        return null
      }
      parts.pop()
    } else if (part !== '.' && part !== '') {
      parts.push(part)
    }
  }
  return parts.length > 0 ? parts.join('/') : null
}

function references(file: string, text: string): string[] {
  const found = [...text.matchAll(RELATIVE_IMPORT)].map((match) => match[1]!)
  if (/\.html?$/i.test(file)) {
    for (const match of text.matchAll(SCRIPT_SRC)) {
      // Why: a URL, protocol-relative or root path is not a file this plugin ships.
      if (!/^(?:[a-z][\w+.-]*:|\/)/i.test(match[1]!)) {
        found.push(match[1]!)
      }
    }
  }
  return found
}

type ScanTarget = [file: string, surface: PluginSurface]

function entryFiles(manifest: PluginManifest): ScanTarget[] {
  const c = manifest.contributes
  const worker: ScanTarget[] = manifest.main ? [[manifest.main, 'worker']] : []
  return [
    ...worker,
    ...c.panels.map((panel): ScanTarget => [panel.entry, 'panel']),
    ...c.customEditors.map((editor): ScanTarget => [editor.entry, 'editor'])
  ]
}

/** Every literal host call and `has` guard in the code each entry ships, with its surface. */
function scanHostCalls(manifest: PluginManifest, read: PluginArtifactTextReader) {
  const calls: HostCall[] = []
  const guarded = new Set<string>()
  const texts = new Map<string, string | null>()
  let files = 0
  let chars = 0
  let truncated = false
  const load = (path: string): string | null => {
    if (!texts.has(path)) {
      if (files >= MAX_SCANNED_FILES || chars >= MAX_SCANNED_CHARS) {
        truncated = true
        return null
      }
      const text = read(path)
      if (text !== null) {
        files += 1
        chars += text.length
      }
      texts.set(path, text)
    }
    return texts.get(path) ?? null
  }
  const visited = new Set<string>()
  const queue = entryFiles(manifest)
  while (queue.length > 0) {
    const [file, surface] = queue.shift()!
    const key = `${surface}:${file}`
    if (visited.has(key)) {
      continue
    }
    visited.add(key)
    const text = load(file)
    if (text === null) {
      continue
    }
    for (const [, kind, , name] of text.matchAll(HOST_CALL)) {
      if (!HOST_NAMESPACES.has(name!.split('.')[0]!)) {
        continue
      }
      if (kind === 'has') {
        guarded.add(name!)
      } else {
        calls.push({ name: name!, file, surface })
      }
    }
    for (const reference of references(file, text)) {
      const base = resolveInPlugin(file, reference)
      const target = base && IMPORT_SUFFIXES.map((suffix) => base + suffix).find((p) => load(p))
      if (target) {
        queue.push([target, surface])
      }
    }
  }
  return { calls, guarded, truncated }
}

function once(calls: HostCall[], keyOf: (call: HostCall) => string): HostCall[] {
  const first = new Map<string, HostCall>()
  for (const call of calls) {
    if (!first.has(keyOf(call))) {
      first.set(keyOf(call), call)
    }
  }
  return [...first.values()]
}

const thisHostApi = `Host API ${PLUGIN_HOST_API_MAJOR}.${PLUGIN_HOST_API_MINOR}`

/**
 * Errors for host calls this Orca or the declared `engines.orca` cannot serve. Why at validation:
 * a call that slips through fails only at runtime, with `unknown_method` on users' older Orca.
 */
export function pluginHostCallErrors(
  manifest: PluginManifest,
  read: PluginArtifactTextReader
): string[] {
  const { calls, guarded } = scanHostCalls(manifest, read)
  const declared = manifest.engines.orca.slice(2)
  // Why: on Orca without `host.has`, the guard itself throws, so it protects nothing.
  const guardWorks = satisfiesOrcaEngineRange(declared, `>=${PLUGIN_HOST_HAS_SINCE}`)
  const errors: string[] = []
  const reported = new Set<string>()
  for (const call of once(calls, (c) => `${c.surface}:${c.name}`)) {
    const spec = getPluginHostMethodSpec(call.name)
    if (spec === null || spec.proposed) {
      // Why once per name: these hold for every surface, so a second file adds nothing.
      if (reported.has(call.name)) {
        continue
      }
      reported.add(call.name)
    }
    if (spec === null) {
      if (!guarded.has(call.name)) {
        errors.push(
          `${call.file}: calls host method "${call.name}", which Orca's ${thisHostApi} does not have; it is unreleased or misspelled`
        )
      }
      continue
    }
    if (spec.proposed) {
      errors.push(
        `${call.file}: calls proposed host method "${call.name}"; only development plugins (orca plugin dev) may call it until it is released`
      )
      continue
    }
    if (!spec.surfaces.includes(call.surface)) {
      errors.push(
        `${call.file}: calls host method "${call.name}" from ${SURFACE_LABELS[call.surface]}, which cannot call it (surfaces: ${spec.surfaces.join(', ')})`
      )
      continue
    }
    const needs = pluginHostMethodRelease(spec, call.surface)
    if (
      needs !== null &&
      !satisfiesOrcaEngineRange(declared, `>=${needs}`) &&
      !(guardWorks && guarded.has(call.name))
    ) {
      errors.push(
        `engines.orca: must be at least >=${needs}, because ${call.file} calls host method "${call.name}", which needs Orca ${needs}; or guard the call with orca.host.has('${call.name}')${guardWorks ? '' : ` and engines.orca >=${PLUGIN_HOST_HAS_SINCE}, where orca.host.has arrived`}`
      )
    }
  }
  return errors
}

/**
 * Advice about host calls that work today. Each deprecation starts with
 * `deprecated host method <name>`; catalog tooling matches that prefix, so keep it stable.
 */
export function pluginHostCallWarnings(
  manifest: PluginManifest,
  read: PluginArtifactTextReader
): string[] {
  const { calls, guarded, truncated } = scanHostCalls(manifest, read)
  const warnings: string[] = []
  for (const call of once(calls, (c) => c.name)) {
    const spec = getPluginHostMethodSpec(call.name)
    if (spec === null && guarded.has(call.name)) {
      warnings.push(
        `${call.file}: host method "${call.name}" is not in Orca's ${thisHostApi}; it is unreleased or misspelled, and the orca.host.has('${call.name}') guard skips it here`
      )
    } else if (spec?.deprecatedSince !== undefined) {
      warnings.push(
        `deprecated host method ${call.name}: called in ${call.file}; deprecated since Host API ${PLUGIN_HOST_API_MAJOR}.${spec.deprecatedSince}, it keeps working until the next major`
      )
    }
  }
  if (truncated) {
    warnings.push(
      `host calls were checked in the first ${MAX_SCANNED_FILES} files (${MAX_SCANNED_CHARS / 1024 / 1024} MiB) the entries load; the rest were not checked`
    )
  }
  return warnings
}
