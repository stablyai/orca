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
import { stripScriptComments } from './plugin-script-comment-stripping'

/** What reading one plugin file gave: its text, why it was not read, or null when absent. */
export type PluginCodeRead = { text: string } | { skipped: string } | null
/** Reads a plugin file by manifest path, refusing it unread when it exceeds `maxBytes`. */
export type PluginCodeReader = (manifestPath: string, maxBytes: number) => Promise<PluginCodeRead>
export type PluginHostCallFindings = { errors: string[]; warnings: string[] }

// Why bounded: a plugin ships its bundle plus a few chunks; anything past this is not host code.
const MAX_SCANNED_FILES = 64
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const IMPORT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.jsx', '/index.js']

// Why a `host` receiver: `orca.host.call` survives bundling, and an unrelated `fn.call('a.b')` must not count.
const HOST_CALL = /\bhost\s*\.\s*(call|has)\s*\(\s*(['"`])([A-Za-z]\w*(?:\.\w+)+)\2/g
const API_MINOR = String.raw`\bapi\s*\??\.\s*minor\b`
const COMPARISON = String.raw`(?:[<>]=?|[!=]==?)`
const API_MINOR_CHECK = new RegExp(
  `${API_MINOR}\\s*${COMPARISON}|${COMPARISON}\\s*(?:[\\w$]+\\s*\\??\\.\\s*)*${API_MINOR}`
)
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"](\.{1,2}\/[^'"\s]+)['"]/g
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi
const HTML_FILE = /\.html?$/i

const HOST_NAMESPACES = new Set(PLUGIN_HOST_METHOD_NAMES.map((name) => name.split('.')[0]))

const SURFACE_LABELS: Record<PluginSurface, string> = {
  worker: 'the worker',
  panel: 'panels',
  editor: 'custom editors'
}

type HostCall = { name: string; file: string; surface: PluginSurface }
type ScanTarget = [file: string, surface: PluginSurface]

/** Resolves a reference against a plugin file (a leading `/` is the plugin root); null outside it. */
function resolveInPlugin(from: string, reference: string): string | null {
  const rooted = reference.startsWith('/')
  const parts = rooted ? [] : from.split('/').slice(0, -1)
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

function references(file: string, code: string): string[] {
  const found = [...code.matchAll(RELATIVE_IMPORT)].map((match) => match[1]!)
  if (HTML_FILE.test(file)) {
    for (const match of code.matchAll(SCRIPT_SRC)) {
      // Why: a URL or protocol-relative source is not a file this plugin ships.
      if (!/^(?:[a-z][\w+.-]*:|\/\/)/i.test(match[1]!)) {
        found.push(match[1]!)
      }
    }
  }
  return found
}

function entryFiles(manifest: PluginManifest): ScanTarget[] {
  const c = manifest.contributes
  const worker: ScanTarget[] = manifest.main ? [[manifest.main, 'worker']] : []
  return [
    ...worker,
    ...c.panels.map((panel): ScanTarget => [panel.entry, 'panel']),
    ...c.customEditors.map((editor): ScanTarget => [editor.entry, 'editor'])
  ]
}

/**
 * Every literal host call in the code each entry ships, with its surface. `has` guards and
 * `api.minor` checks count plugin-wide, not per call site: matching a guard to the call it
 * protects needs control flow, and a missed guard would block a correct plugin.
 */
async function scanHostCalls(manifest: PluginManifest, read: PluginCodeReader) {
  const calls: HostCall[] = []
  const guarded = new Set<string>()
  const notes: string[] = []
  const codes = new Map<string, string | null>()
  let minorChecked = false
  let files = 0
  let bytes = 0
  let truncated = false
  const load = async (path: string): Promise<string | null> => {
    if (codes.has(path)) {
      return codes.get(path)!
    }
    const budget = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - bytes)
    if (files >= MAX_SCANNED_FILES || budget <= 0) {
      truncated = true
      return null
    }
    const result = await read(path, budget)
    if (result !== null && 'skipped' in result) {
      notes.push(`${path}: host calls not checked: ${result.skipped}`)
    }
    const text = result !== null && 'text' in result ? result.text : null
    files += text === null ? 0 : 1
    bytes += text?.length ?? 0
    const code = text === null ? null : stripScriptComments(text, HTML_FILE.test(path))
    codes.set(path, code)
    return code
  }
  const visited = new Set<string>()
  for (const entry of entryFiles(manifest)) {
    const queue: ScanTarget[] = [entry]
    let scripts = 0
    while (queue.length > 0) {
      const [file, surface] = queue.shift()!
      if (visited.has(`${surface}:${file}`)) {
        scripts += 1
        continue
      }
      visited.add(`${surface}:${file}`)
      const code = await load(file)
      if (code === null) {
        continue
      }
      scripts += file === entry[0] ? 0 : 1
      minorChecked ||= API_MINOR_CHECK.test(code)
      for (const [, kind, , name] of code.matchAll(HOST_CALL)) {
        if (!HOST_NAMESPACES.has(name!.split('.')[0]!)) {
          continue
        }
        if (kind === 'has') {
          guarded.add(name!)
        } else {
          calls.push({ name: name!, file, surface })
        }
      }
      for (const reference of references(file, code)) {
        const base = resolveInPlugin(file, reference)
        for (const suffix of base === null ? [] : IMPORT_SUFFIXES) {
          if ((await load(base + suffix)) !== null) {
            queue.push([base + suffix, surface])
            break
          }
        }
      }
    }
    const [file] = entry
    const html = HTML_FILE.test(file) ? codes.get(file) : null
    const inline = [...(html ?? '').matchAll(INLINE_SCRIPT)].some((m) => m[1]!.trim() !== '')
    if (typeof html === 'string' && scripts === 0 && !inline) {
      notes.push(
        `${file}: loads no script this check could read, so its host calls were not checked`
      )
    }
  }
  if (truncated) {
    notes.push(
      `host calls were checked in the first ${MAX_SCANNED_FILES} files (${MAX_TOTAL_BYTES / 1024 / 1024} MiB) the entries load; the rest were not checked`
    )
  }
  return { calls, guarded, minorChecked, notes }
}

function firstPer(calls: HostCall[], keyOf: (call: HostCall) => string): HostCall[] {
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
 * Host calls this Orca or the declared `engines.orca` cannot serve. Why at validation: a call that
 * slips through fails only at runtime, with `unknown_method` on users' older Orca. A call guarded
 * by `orca.host.has(name)` is a warning instead; so is a floor miss in a plugin that compares
 * `orca.api.minor` anywhere, a lenient reading of the documented detection. Each deprecation
 * warning starts `deprecated host method <name>`; catalog tooling matches that prefix.
 */
export async function pluginHostCallFindings(
  manifest: PluginManifest,
  read: PluginCodeReader
): Promise<PluginHostCallFindings> {
  const { calls, guarded, minorChecked, notes } = await scanHostCalls(manifest, read)
  const declared = manifest.engines.orca.slice(2)
  // Why: on Orca before `host.has` and `api`, a guard throws, so it protects nothing.
  const guardWorks = satisfiesOrcaEngineRange(declared, `>=${PLUGIN_HOST_HAS_SINCE}`)
  const errors: string[] = []
  const warnings: string[] = []
  const add = (isGuarded: boolean, message: string, guardNote: string) =>
    isGuarded ? warnings.push(`${message}; ${guardNote}`) : errors.push(message)
  const hasNote = (name: string) => `the orca.host.has('${name}') guard skips it`
  for (const call of firstPer(calls, (c) => c.name)) {
    const spec = getPluginHostMethodSpec(call.name)
    const isGuarded = guarded.has(call.name)
    if (spec === null) {
      add(
        isGuarded,
        `${call.file}: calls host method "${call.name}", which Orca's ${thisHostApi} does not have; it is unreleased or misspelled`,
        hasNote(call.name)
      )
    } else if (spec.proposed) {
      add(
        isGuarded,
        `${call.file}: calls proposed host method "${call.name}"; only development plugins (orca plugin dev) may call it until it is released`,
        hasNote(call.name)
      )
    } else if (spec.deprecatedSince !== undefined) {
      warnings.push(
        `deprecated host method ${call.name}: called in ${call.file}; deprecated since Host API ${PLUGIN_HOST_API_MAJOR}.${spec.deprecatedSince}, it keeps working until the next major`
      )
    }
  }
  for (const call of firstPer(calls, (c) => `${c.surface}:${c.name}`)) {
    const spec = getPluginHostMethodSpec(call.name)
    if (spec === null || spec.proposed) {
      continue
    }
    const isGuarded = guarded.has(call.name)
    if (!spec.surfaces.includes(call.surface)) {
      add(
        isGuarded,
        `${call.file}: calls host method "${call.name}" from ${SURFACE_LABELS[call.surface]}, which cannot call it (surfaces: ${spec.surfaces.join(', ')})`,
        hasNote(call.name)
      )
      continue
    }
    const needs = pluginHostMethodRelease(spec, call.surface)
    if (
      needs === null ||
      satisfiesOrcaEngineRange(declared, `>=${needs}`) ||
      (guardWorks && isGuarded)
    ) {
      continue
    }
    add(
      guardWorks && minorChecked,
      `engines.orca: must be at least >=${needs}, because ${call.file} calls host method "${call.name}", which needs Orca ${needs}; or guard the call with orca.host.has('${call.name}')${guardWorks ? '' : ` and engines.orca >=${PLUGIN_HOST_HAS_SINCE}, where orca.host.has arrived`}`,
      'taken as guarded by the orca.api.minor check in this plugin'
    )
  }
  return { errors, warnings: [...warnings, ...notes] }
}
