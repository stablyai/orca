/**
 * Method names and param shapes for the office surface, shared by the SSH relay handler, the
 * paired-runtime methods and the client that calls both. One list, so a method cannot be spelled
 * one way on the relay and another on a runtime.
 *
 * Params are deliberately minimal — a document path, and for skills a list of pairs. Everything
 * else (which lane, which temp directory, which port) is the host's business, decided on the host.
 */

import { posix, win32 } from 'node:path'
export const OFFICE_PROBE_METHOD = 'office.probe' as const
export const OFFICE_RENDER_METHOD = 'office.render' as const
export const OFFICE_WATCH_START_METHOD = 'office.watchStart' as const
export const OFFICE_WATCH_REFRESH_METHOD = 'office.watchRefresh' as const
export const OFFICE_WATCH_STOP_METHOD = 'office.watchStop' as const
export const OFFICE_SELECTION_METHOD = 'office.selection' as const
export const OFFICE_MARKS_METHOD = 'office.marks' as const
export const OFFICE_CLEAR_MARKS_METHOD = 'office.clearMarks' as const
/** Scrolls every page connected to the watch process to one element. */
export const OFFICE_GOTO_METHOD = 'office.goto' as const
export const OFFICE_SKILLS_LIST_METHOD = 'office.skillsList' as const
export const OFFICE_SKILLS_INSTALL_METHOD = 'office.skillsInstall' as const

export const OFFICE_RPC_METHODS = [
  OFFICE_PROBE_METHOD,
  OFFICE_RENDER_METHOD,
  OFFICE_WATCH_START_METHOD,
  OFFICE_WATCH_REFRESH_METHOD,
  OFFICE_WATCH_STOP_METHOD,
  OFFICE_SELECTION_METHOD,
  OFFICE_MARKS_METHOD,
  OFFICE_CLEAR_MARKS_METHOD,
  OFFICE_GOTO_METHOD,
  OFFICE_SKILLS_LIST_METHOD,
  OFFICE_SKILLS_INSTALL_METHOD
] as const

export type OfficeRpcMethod = (typeof OFFICE_RPC_METHODS)[number]

/**
 * Every document method names a workspace root and a path relative to it, never a bare absolute
 * path — the same shape every runtime `files.*` method uses. The host joins the two, canonicalises
 * them and proves the result still sits inside the root before anything reaches a spawn, so a
 * `../../` in the relative half is refused on the host rather than trusted from the wire.
 */
export type OfficeWorkspaceDocumentParams = { workspaceRoot: string; relativePath: string }
/** Absent root on a probe or a skills call means "this host's default lane". */
export type OfficeDocumentParams = { workspaceRoot?: string }
/** `refresh` drops the host's cached answer first — the Retry control after a reader installs. */
export type OfficeProbeParams = { workspaceRoot?: string; refresh?: boolean }
/** An officecli data-path such as `/slide[1]/shape[@id=100000]`, taken from a mark or a selection. */
export type OfficeElementParams = OfficeWorkspaceDocumentParams & { elementPath: string }
export type OfficeSkillInstallParams = {
  pairs: readonly { skill: string; agent: string }[]
  workspaceRoot?: string
}

const MAX_ELEMENT_PATH_LENGTH = 1_024
const MAX_PATH_LENGTH = 4_096
const MAX_RELATIVE_PATH_LENGTH = 2_048
const MAX_SKILL_PAIRS = 200
/** Skill and agent ids are the tool's own identifiers; anything else is not one. */
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i

/**
 * Host-side shape validation, run before any value reaches a spawn.
 *
 * Shape only — the boundary itself is enforced after canonicalisation, in
 * `resolveOfficeDocumentTarget`, because a lexical check cannot see through a symlink. Nothing
 * that survives here is ever interpolated into a shell string; it becomes one argv element.
 */
export function isValidOfficeDocumentPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0')
  )
}

/** A workspace-relative path: never absolute, never empty, and length-bounded. */
export function isValidOfficeRelativePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_RELATIVE_PATH_LENGTH &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    !value.startsWith('\\') &&
    !/^[a-zA-Z]:/.test(value)
  )
}

/**
 * Joins a workspace root and a relative path, collapsing `.` and `..` in the result.
 *
 * The collapse is what lets a caller that cannot canonicalise — the stop path, once the document
 * has been deleted — still test containment lexically. `isPathInsideOrEqual` folds separators and
 * case but does **not** resolve `..`, so `/w/repo/../../elsewhere/x.docx` would otherwise read as
 * inside `/w/repo`. Normalising here keeps that trap in one place rather than at each call site.
 *
 * Still not a substitute for canonicalisation: a symlink inside the root defeats any lexical
 * check, which is why `resolveOfficeDocumentTarget` re-tests containment after `realpath`.
 */
export function joinOfficeRelativePath(workspaceRoot: string, relativePath: string): string | null {
  if (!isValidOfficeDocumentPath(workspaceRoot) || !isValidOfficeRelativePath(relativePath)) {
    return null
  }
  const isWindowsShaped = /^[a-zA-Z]:/.test(workspaceRoot) || workspaceRoot.startsWith('\\\\')
  const flavor = isWindowsShaped ? win32 : posix
  const trimmedRoot = workspaceRoot.replace(/[/\\]+$/, '')
  const separator = isWindowsShaped ? '\\' : '/'
  const suffix = relativePath.replace(/^[/\\]+/, '')
  return flavor.normalize(`${trimmedRoot}${separator}${suffix}`)
}

/** Shape-checked only: the host passes it as one argv element and never into a shell string. */
export function isValidOfficeElementPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= MAX_ELEMENT_PATH_LENGTH &&
    !value.includes('\0')
  )
}

export function isValidOfficeSkillId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_ID_PATTERN.test(value)
}

export function parseOfficeSkillInstallPairs(
  value: unknown
): { skill: string; agent: string }[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SKILL_PAIRS) {
    return null
  }
  const pairs: { skill: string; agent: string }[] = []
  for (const entry of value) {
    const record = entry as { skill?: unknown; agent?: unknown } | null
    if (!record || !isValidOfficeSkillId(record.skill) || !isValidOfficeSkillId(record.agent)) {
      return null
    }
    pairs.push({ skill: record.skill, agent: record.agent })
  }
  return pairs
}
