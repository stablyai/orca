/**
 * The wire shape of Office preview work, shared by every execution host.
 *
 * Failures cross the boundary as a stable `code`, never as a message: the renderer owns
 * all reader-facing copy and its localisation. `detail` carries host diagnostics for the
 * log and the expandable "what the tool said" row — it is never the primary sentence.
 */

import type { OfficeDocKind } from './office-file-extensions'

export const OFFICE_ERROR_CODES = [
  /** No `officecli` on the owning host's PATH or in its known install locations. */
  'OFFICECLI_NOT_FOUND',
  /** The host has the binary but the document's format is not one it renders. */
  'OFFICECLI_UNSUPPORTED_FORMAT',
  /** The binary ran and refused, or produced nothing usable. */
  'OFFICECLI_RENDER_FAILED',
  'OFFICECLI_FILE_NOT_FOUND',
  /** The document named does not live inside the workspace it was named against. */
  'OFFICE_DOCUMENT_OUTSIDE_WORKSPACE',
  /** Another process already watches this document; not a failure of ours. */
  'OFFICECLI_ALREADY_WATCHED',
  /** The watch server never began accepting connections inside the readiness budget. */
  'OFFICECLI_PORT_TIMEOUT',
  'OFFICECLI_WATCH_FAILED',
  /** No watch session for this document on this host — refresh and stop have nothing to act on. */
  'OFFICE_WATCH_NOT_RUNNING',
  /** Rendered HTML exceeds the transport cap. Never truncated — refused. */
  'OFFICE_RENDER_TOO_LARGE',
  /** A paired host that predates `office.preview.v1`. */
  'OFFICE_HOST_UPDATE_REQUIRED',
  /**
   * The owning host could not be reached. Per docs/reference/ssh-execution-boundary.md this is
   * `unverifiable`: it says nothing about whether the work or a watch process is alive.
   */
  'OFFICE_HOST_UNREACHABLE'
] as const

export type OfficeErrorCode = (typeof OFFICE_ERROR_CODES)[number]

export type OfficeFailure = {
  ok: false
  code: OfficeErrorCode
  /** Host-side diagnostic text. Secondary detail only; never the sentence a reader is shown. */
  detail?: string
}

export function officeFailure(code: OfficeErrorCode, detail?: string): OfficeFailure {
  return detail ? { ok: false, code, detail } : { ok: false, code }
}

export function isOfficeErrorCode(value: unknown): value is OfficeErrorCode {
  return typeof value === 'string' && (OFFICE_ERROR_CODES as readonly string[]).includes(value)
}

/** Host platforms the install guidance distinguishes. `unknown` gets the releases page alone. */
export type OfficeHostPlatform = 'darwin' | 'linux' | 'win32' | 'unknown'

export const OFFICECLI_RELEASES_URL = 'https://github.com/iOfficeAI/OfficeCli/releases'

/**
 * The command a reader runs themselves. Orca never executes it — see §7.3 of
 * docs/office-document-support-plan.md and docs/reference/windows-edr-posture.md: Orca
 * originating a PowerShell invocation against a downloaded script is a behavioural signature
 * we decline to add, and the same restraint applies to the shell one-liner on POSIX.
 */
export function officeInstallCommandForPlatform(platform: OfficeHostPlatform): string | null {
  switch (platform) {
    case 'darwin':
    case 'linux':
      return 'curl -fsSL https://d.officecli.ai/install.sh | bash'
    case 'win32':
      return 'irm https://d.officecli.ai/install.ps1 | iex'
    case 'unknown':
      return null
  }
}

export type OfficeProbeResult = {
  installed: boolean
  /** As reported by `officecli --version`; absent when the binary is missing or mute. */
  version: string | null
  /** Whether this build has the `watch` subcommand, which Phase 2's live toggle needs. */
  supportsWatch: boolean
  platform: OfficeHostPlatform
  /** Absolute path the host resolved, for the diagnostic row. Never shown as the headline. */
  resolvedPath: string | null
}

export type OfficeProbeOutcome = ({ ok: true } & OfficeProbeResult) | OfficeFailure

export type OfficeRenderOutcome = { ok: true; html: string; kind: OfficeDocKind } | OfficeFailure

export type OfficeWatchStatus = 'starting' | 'ready' | 'error'

export type OfficeWatchOutcome =
  | {
      ok: true
      port: number
      /** True when the host adopted a watch server that was already serving this document. */
      adopted: boolean
    }
  | OfficeFailure

export type OfficeAckOutcome = { ok: true } | OfficeFailure

/** One element the reader selected in a live preview. `path` is officecli's stable data-path. */
export type OfficeSelectionNode = {
  path: string
  type: string | null
  text: string | null
}

export type OfficeSelectionOutcome = { ok: true; nodes: OfficeSelectionNode[] } | OfficeFailure

/** Advisory annotation held by a watch process. Ephemeral: it dies with the process. */
export type OfficeMark = {
  id: string
  path: string
  note: string | null
  color: string | null
  /** The tool reports a mark whose anchor no longer matches the document as stale. */
  stale: boolean
}

export type OfficeMarksOutcome = { ok: true; marks: OfficeMark[] } | OfficeFailure

export type OfficeSkill = { id: string; description: string | null }
export type OfficeSkillAgent = { id: string; label: string | null; detected: boolean }

export type OfficeSkillCatalogOutcome =
  | { ok: true; skills: OfficeSkill[]; agents: OfficeSkillAgent[] }
  | OfficeFailure

export type OfficeSkillInstallResult = {
  skill: string
  agent: string
  installed: boolean
  detail: string | null
}

export type OfficeSkillInstallOutcome =
  | { ok: true; results: OfficeSkillInstallResult[] }
  | OfficeFailure

/** Any answer an office method can give. One union so a transport can carry them all untyped. */
export type OfficeMethodResult =
  | OfficeProbeOutcome
  | OfficeRenderOutcome
  | OfficeWatchOutcome
  | OfficeAckOutcome
  | OfficeSelectionOutcome
  | OfficeMarksOutcome
  | OfficeSkillCatalogOutcome
  | OfficeSkillInstallOutcome

/**
 * Cap on a rendered snapshot crossing the wire, matching the document-preview read caps in
 * `src/main/browser/doc-preview-file-reader.ts`. Over it we refuse with a distinct code and
 * offer the live preview instead — never half a document.
 */
export const OFFICE_RENDER_MAX_BYTES = 10 * 1024 * 1024

/** Readiness poll for a freshly spawned watch server. A render budget, not a network one. */
export const OFFICE_WATCH_READY_POLL_INTERVAL_MS = 100
export const OFFICE_WATCH_READY_TIMEOUT_MS = 15_000
/** `POST /api/switch` re-renders the document synchronously, so it gets a generous ceiling. */
export const OFFICE_WATCH_SWITCH_TIMEOUT_MS = 60_000
/** Rendering a media-heavy deck is slow; this is the whole `view … html` budget. */
export const OFFICE_RENDER_TIMEOUT_MS = 120_000
export const OFFICE_PROBE_TIMEOUT_MS = 10_000
