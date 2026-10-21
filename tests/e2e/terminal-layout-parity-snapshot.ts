/**
 * Normalize and compare terminal layout parity captures (see terminal-layout-parity.spec.ts).
 * Volatile values become structural labels so two runs of one commit compare equal.
 */

export const TERMINAL_LAYOUT_PARITY_OUT_ENV = 'ORCA_TERMINAL_LAYOUT_PARITY_OUT'

export type RawParityCheckpoint = {
  label: string
  renderer: unknown
  persisted: unknown
  /** How the app exited before `persisted` was read; a forced kill skips the final save. */
  exit?: { code: number | null; signal: string | null }
}

export type RawParityCapture = {
  scenario: string
  /** Absolute machine paths to replace with stable labels, e.g. the seeded repo → `<repo>`. */
  pathLabels: Record<string, string>
  checkpoints: RawParityCheckpoint[]
}

/** A named bug this branch fixes, and the capture paths (prefixes) its fix is allowed to change. */
export type DeclaredParityDifference = {
  scenario: string
  bugId: string
  paths: string[]
  reason: string
}

/** A path main itself does not reproduce run to run; compared differences there are reported, not failed. */
export type UnstableOnMainPath = { scenario: string; paths: string[]; evidence: string }

export type ParityDifference = { scenario: string; path: string; base: unknown; head: unknown }

export type ParityReport = {
  undeclared: ParityDifference[]
  declared: (ParityDifference & { bugId: string })[]
  unstableOnMain: ParityDifference[]
  /** Declarations whose fix produced no difference: the claimed fix was not observed. */
  unusedDeclarations: DeclaredParityDifference[]
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// UUIDs, and the per-spawn suffix of local PTY ids (`<worktreeId>@@1e2745c7`).
const ID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@@[0-9a-f]{8}\\b'
// `createdAt`, `lastFocusedAt`, and maps of them such as `lastVisitedAtByWorktreeId`.
const TIME_KEY = /(?:At|Time|timestamp)(?:By[A-Za-z]+)?$/
const PROCESS_KEY = /^(?:pid|port|processId)$/i
// Scrollback text depends on prompt timing, not layout; keep presence only.
const OPAQUE_TEXT_PARENT_KEYS = new Set(['buffersByLeafId', 'localOnlyScrollbackByTabId'])

function findIds(text: string): string[] {
  return (text.match(new RegExp(ID_SOURCE, 'gi')) ?? []).map((id) => id.toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Labels each volatile id by where it first appears in ordered structure, never by its value. */
class IdLabeler {
  private readonly labels = new Map<string, string>()

  label(id: string): string {
    let label = this.labels.get(id)
    if (!label) {
      label = `${id.startsWith('@@') ? '@@' : ''}#${this.labels.size + 1}`
      this.labels.set(id, label)
    }
    return label
  }

  knows(key: string): boolean {
    return findIds(key).every((id) => this.labels.has(id))
  }

  replaceIn(text: string): string {
    return text.replace(new RegExp(ID_SOURCE, 'gi'), (id) => this.label(id.toLowerCase()))
  }

  /**
   * Arrays in order, plain keys sorted. A map keyed by ids is visited only once its ids are labeled
   * elsewhere (e.g. tab ids from the ordered tab list), so random id order never picks a label.
   */
  visit(root: unknown): void {
    const pending: [string, unknown][] = []
    const walk = (value: unknown): void => {
      if (typeof value === 'string') {
        findIds(value).forEach((id) => this.label(id))
      } else if (Array.isArray(value)) {
        value.forEach(walk)
      } else if (isRecord(value)) {
        for (const key of Object.keys(value).sort()) {
          if (findIds(key).length === 0) {
            walk(value[key])
          } else {
            pending.push([key, value[key]])
          }
        }
      }
    }
    walk(root)
    while (pending.length > 0) {
      const ready = pending.filter(([key]) => this.knows(key))
      // Fallback for ids seen only as keys: raw order, the one place a label can depend on value.
      const next =
        ready.length > 0 ? ready : [pending.toSorted((a, b) => a[0].localeCompare(b[0]))[0]!]
      const rank = (key: string): string =>
        this.replaceIn(key).replace(/\d+/g, (n) => n.padStart(6, '0'))
      next.sort((a, b) => rank(a[0]).localeCompare(rank(b[0])))
      for (const entry of next) {
        pending.splice(pending.indexOf(entry), 1)
        findIds(entry[0]).forEach((id) => this.label(id))
        walk(entry[1])
      }
    }
  }
}

function replacePaths(text: string, pathLabels: [string, string][]): string {
  let result = text
  for (const [machinePath, label] of pathLabels) {
    result = result.split(machinePath).join(label)
  }
  return result
}

function normalizeValue(
  value: unknown,
  key: string,
  parentKey: string,
  labeler: IdLabeler,
  pathLabels: [string, string][]
): Json {
  if (typeof value === 'string') {
    return OPAQUE_TEXT_PARENT_KEYS.has(parentKey)
      ? '<text>'
      : labeler.replaceIn(replacePaths(value, pathLabels))
  }
  if (typeof value === 'number') {
    if (TIME_KEY.test(key) || TIME_KEY.test(parentKey)) {
      return '<time>'
    }
    return PROCESS_KEY.test(key) ? '<process>' : value
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, key, parentKey, labeler, pathLabels))
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([childKey, child]): [string, Json] => [
      labeler.replaceIn(replacePaths(childKey, pathLabels)),
      normalizeValue(child, childKey, key, labeler, pathLabels)
    ])
    return Object.fromEntries(entries.sort((a, b) => a[0].localeCompare(b[0])))
  }
  return typeof value === 'boolean' || value === null ? value : null
}

/** One labeler per capture so a tab keeps its label from renderer to disk to restart. */
export function normalizeParityCapture(capture: RawParityCapture): Json {
  const labeler = new IdLabeler()
  const pathLabels = Object.entries(capture.pathLabels).sort((a, b) => b[0].length - a[0].length)
  for (const checkpoint of capture.checkpoints) {
    labeler.visit(checkpoint.renderer)
    labeler.visit(checkpoint.persisted)
  }
  return capture.checkpoints.map((checkpoint) => ({
    label: checkpoint.label,
    exit: checkpoint.exit ?? null,
    renderer: normalizeValue(checkpoint.renderer, 'renderer', '', labeler, pathLabels),
    persisted: normalizeValue(checkpoint.persisted, 'persisted', '', labeler, pathLabels)
  }))
}

// An absent map and an empty one mean the same; which one a save writes depends on its writer.
function isEmpty(value: Json | undefined): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) ? value.length === 0 : isRecord(value) && Object.keys(value).length === 0)
  )
}

function isEmptyPair(base: Json | undefined, head: Json | undefined): boolean {
  return isEmpty(base) && isEmpty(head)
}

function diffJson(
  base: Json | undefined,
  head: Json | undefined,
  path: string,
  out: [string, Json | undefined, Json | undefined][]
): void {
  if (JSON.stringify(base) === JSON.stringify(head) || isEmptyPair(base, head)) {
    return
  }
  if (Array.isArray(base) && Array.isArray(head)) {
    for (let index = 0; index < Math.max(base.length, head.length); index += 1) {
      diffJson(base[index], head[index], `${path}[${index}]`, out)
    }
    return
  }
  if (isRecord(base) && isRecord(head)) {
    for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
      diffJson(base[key], head[key], `${path}.${key}`, out)
    }
    return
  }
  out.push([path, base, head])
}

function matchesPath(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`)
}

export function compareParityCaptures(
  base: Map<string, RawParityCapture>,
  head: Map<string, RawParityCapture>,
  declarations: readonly DeclaredParityDifference[],
  unstableOnMain: readonly UnstableOnMainPath[] = []
): ParityReport {
  const report: ParityReport = {
    undeclared: [],
    declared: [],
    unstableOnMain: [],
    unusedDeclarations: []
  }
  const covers = (entry: { scenario: string; paths: string[] }, scenario: string, path: string) =>
    entry.scenario === scenario && entry.paths.some((prefix) => matchesPath(path, prefix))
  const used = new Set<DeclaredParityDifference>()
  for (const scenario of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const baseCapture = base.get(scenario)
    const headCapture = head.get(scenario)
    const found: [string, Json | undefined, Json | undefined][] = []
    diffJson(
      baseCapture ? normalizeParityCapture(baseCapture) : undefined,
      headCapture ? normalizeParityCapture(headCapture) : undefined,
      '',
      found
    )
    for (const [path, baseValue, headValue] of found) {
      const difference = {
        scenario,
        path,
        base: baseValue === undefined ? '<missing>' : baseValue,
        head: headValue === undefined ? '<missing>' : headValue
      }
      const declaration = declarations.find((entry) => covers(entry, scenario, path))
      if (declaration) {
        used.add(declaration)
        report.declared.push({ ...difference, bugId: declaration.bugId })
      } else if (unstableOnMain.some((entry) => covers(entry, scenario, path))) {
        report.unstableOnMain.push(difference)
      } else {
        report.undeclared.push(difference)
      }
    }
  }
  report.unusedDeclarations = declarations.filter((entry) => !used.has(entry))
  return report
}

export function isParityClean(report: ParityReport): boolean {
  return report.undeclared.length === 0 && report.unusedDeclarations.length === 0
}
