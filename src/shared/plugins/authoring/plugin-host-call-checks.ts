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
// Why separate caps: missing-import probes read nothing, so the file budget alone never stops them.
const MAX_READ_ATTEMPTS = 512
const MAX_REFERENCES_PER_FILE = 256
const MAX_QUEUED = 512
const IMPORT_SUFFIXES = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.jsx', '/index.js']

// Why a `host` receiver: `orca.host.call` survives bundling, and an unrelated `fn.call('a.b')` must not count.
const HOST_CALL = /\bhost\s*\??\.\s*(call|has)\s*(?:\?\.\s*)?\(\s*(['"`])([A-Za-z]\w*(?:\.\w+)+)\2/g
// Why any argument: `has(method)` with a variable is feature detection too.
const ANY_HAS_CALL = /\bhost\s*\??\.\s*has\s*(?:\?\.\s*)?\(/
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*)['"](\.{1,2}\/[^'"\s]+)['"]/g
const SCRIPT_SRC_ATTRIBUTE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
const HTML_FILE = /\.html?$/i

const HOST_NAMESPACES = new Set(PLUGIN_HOST_METHOD_NAMES.map((name) => name.split('.')[0]))

const SURFACE_LABELS: Record<PluginSurface, string> = {
  worker: 'the worker',
  panel: 'panels',
  editor: 'custom editors'
}

type HostCall = { name: string; file: string; surface: PluginSurface }
type ScanTarget = [file: string, surface: PluginSurface]
type HtmlScripts = { sources: string[]; inlineCode: boolean }

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

/**
 * The `<script>` elements of a page, in one forward pass. Why not a regex: an attribute pattern
 * rescans the rest of the page at every `<script`, and a body may hold `<script` in strings.
 */
function htmlScripts(html: string): HtmlScripts {
  const lower = html.toLowerCase()
  const sources: string[] = []
  let inlineCode = false
  let at = lower.indexOf('<script')
  while (at !== -1) {
    const tagEnd = lower.indexOf('>', at)
    if (tagEnd === -1) {
      break
    }
    const src = SCRIPT_SRC_ATTRIBUTE.exec(html.slice(at + '<script'.length, tagEnd))
    const close = lower.indexOf('</script', tagEnd)
    if (src) {
      sources.push(src[1] ?? src[2] ?? src[3]!)
    } else {
      inlineCode ||= html.slice(tagEnd + 1, close === -1 ? html.length : close).trim() !== ''
    }
    if (close === -1) {
      break
    }
    at = lower.indexOf('<script', close + '</script'.length)
  }
  return { sources, inlineCode }
}

function* references(code: string, scripts: HtmlScripts | null): Generator<string> {
  for (const match of code.matchAll(RELATIVE_IMPORT)) {
    yield match[1]!
  }
  for (const source of scripts?.sources ?? []) {
    // Why: a URL or protocol-relative source is not a file this plugin ships.
    if (!/^(?:[a-z][\w+.-]*:|\/\/)/i.test(source)) {
      yield source
    }
  }
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
 * Every literal host call in the code each entry ships, with its surface. `has` guards count
 * plugin-wide, not per call site: matching a guard to the call it protects needs control flow.
 */
async function scanHostCalls(manifest: PluginManifest, read: PluginCodeReader) {
  const calls: HostCall[] = []
  const guarded = new Set<string>()
  let detects = false
  const notes: string[] = []
  const codes = new Map<string, string | null>()
  let files = 0
  let bytes = 0
  let attempts = 0
  let queued = 0
  let truncated = false
  const load = async (path: string): Promise<string | null> => {
    if (codes.has(path)) {
      return codes.get(path)!
    }
    const budget = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - bytes)
    if (files >= MAX_SCANNED_FILES || budget <= 0 || attempts >= MAX_READ_ATTEMPTS) {
      truncated = true
      return null
    }
    attempts += 1
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
    let followed = 0
    let entryScripts: HtmlScripts | null = null
    while (queue.length > 0 && !truncated) {
      const [file, surface] = queue.shift()!
      const isEntry = file === entry[0]
      if (visited.has(`${surface}:${file}`)) {
        followed += isEntry ? 0 : 1
        continue
      }
      visited.add(`${surface}:${file}`)
      const code = await load(file)
      if (code === null) {
        continue
      }
      followed += isEntry ? 0 : 1
      detects ||= ANY_HAS_CALL.test(code)
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
      const scripts = HTML_FILE.test(file) ? htmlScripts(code) : null
      entryScripts = isEntry ? scripts : entryScripts
      let seen = 0
      for (const reference of references(code, scripts)) {
        seen += 1
        if (seen > MAX_REFERENCES_PER_FILE || queued >= MAX_QUEUED || truncated) {
          truncated = true
          break
        }
        const base = resolveInPlugin(file, reference)
        for (const suffix of base === null ? [] : IMPORT_SUFFIXES) {
          if ((await load(base + suffix)) !== null) {
            queue.push([base + suffix, surface])
            queued += 1
            break
          }
        }
      }
    }
    if (entryScripts !== null && followed === 0 && !entryScripts.inlineCode) {
      notes.push(
        `${entry[0]}: loads no script this check could read, so its host calls were not checked`
      )
    }
  }
  if (truncated) {
    notes.push(
      `host calls were checked in the first ${MAX_SCANNED_FILES} files (${MAX_TOTAL_BYTES / 1024 / 1024} MiB, ${MAX_READ_ATTEMPTS} lookups) the entries load; the rest were not checked`
    )
  }
  return { calls, guarded, detects, notes }
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
 * Host calls this Orca or the declared `engines.orca` cannot serve. Why errors only for unknown
 * and proposed methods: those fail on every released Orca, while a floor or surface miss may sit
 * behind a guard or in code that surface never runs, which a text scan cannot see. An unknown call
 * is a warning once the plugin calls `orca.host.has` at all; a proposed one needs a literal guard.
 * Each deprecation warning starts `deprecated host method <name>`; catalog tooling matches it.
 */
export async function pluginHostCallFindings(
  manifest: PluginManifest,
  read: PluginCodeReader
): Promise<PluginHostCallFindings> {
  const { calls, guarded, detects, notes } = await scanHostCalls(manifest, read)
  const declared = manifest.engines.orca.slice(2)
  // Why: on Orca before `host.has`, the guard throws, so it protects nothing.
  const guardWorks = satisfiesOrcaEngineRange(declared, `>=${PLUGIN_HOST_HAS_SINCE}`)
  const errors: string[] = []
  const warnings: string[] = []
  for (const call of firstPer(calls, (c) => c.name)) {
    const spec = getPluginHostMethodSpec(call.name)
    let failure: string | null = null
    if (spec === null) {
      failure = `${call.file}: calls host method "${call.name}", which Orca's ${thisHostApi} does not have; it is unreleased or misspelled`
    } else if (spec.proposed) {
      failure = `${call.file}: calls proposed host method "${call.name}"; only development plugins (orca plugin dev) may call it until it is released`
    }
    if (failure !== null && guardWorks && guarded.has(call.name)) {
      warnings.push(`${failure}; the orca.host.has('${call.name}') guard skips it`)
    } else if (failure !== null && guardWorks && detects && spec === null) {
      // Why loose: a guard's argument may be a variable, so any has() may cover this call.
      warnings.push(`${failure}; the plugin calls orca.host.has, which may guard it`)
    } else if (failure !== null) {
      errors.push(failure)
    } else if (spec?.deprecatedSince !== undefined) {
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
    if (!spec.surfaces.includes(call.surface)) {
      warnings.push(
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
      warnings.push(
        `engines.orca: must be at least >=${needs}, because ${call.file} calls host method "${call.name}", which needs Orca ${needs}; or guard the call with orca.host.has('${call.name}')${guardWorks ? '' : ` and engines.orca >=${PLUGIN_HOST_HAS_SINCE}, where orca.host.has arrived`}`
      )
    }
  }
  return { errors, warnings: [...warnings, ...notes] }
}
