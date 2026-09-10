/**
 * Renderer↔main channels for Office preview.
 *
 * The renderer names the owning host and a document; it never names a lane, a port, a temp
 * directory or a binary. It also never receives the rendered bytes: `office:openSnapshot` renders
 * on the owning host and answers with a preview URL, so a 10 MB document crosses one process
 * boundary instead of three and the renderer never holds document content at all.
 */
import type { OfficeDocKind } from './office-file-extensions'
import type { OfficeErrorCode } from './office-preview-contracts'
import type { OfficeHostOwner } from './office-host-owner'

export const OFFICE_PROBE_CHANNEL = 'office:probe'
export const OFFICE_OPEN_SNAPSHOT_CHANNEL = 'office:openSnapshot'
export const OFFICE_RELEASE_SNAPSHOT_CHANNEL = 'office:releaseSnapshot'
export const OFFICE_WATCH_START_CHANNEL = 'office:watchStart'
export const OFFICE_WATCH_REFRESH_CHANNEL = 'office:watchRefresh'
export const OFFICE_WATCH_STOP_CHANNEL = 'office:watchStop'
export const OFFICE_SELECTION_CHANNEL = 'office:selection'
export const OFFICE_MARKS_CHANNEL = 'office:marks'
export const OFFICE_CLEAR_MARKS_CHANNEL = 'office:clearMarks'
export const OFFICE_GOTO_CHANNEL = 'office:goto'
export const OFFICE_SKILLS_LIST_CHANNEL = 'office:skillsList'
export const OFFICE_SKILLS_INSTALL_CHANNEL = 'office:skillsInstall'

/**
 * Every document request names the workspace root and a path inside it. The host joins and
 * canonicalises the two and refuses anything landing outside the root, so the renderer never hands
 * a bare absolute path to a spawn.
 */
export type OfficeProbeRequest = {
  owner: OfficeHostOwner
  workspaceRoot?: string
  refresh?: boolean
}
export type OfficeDocumentRequest = {
  owner: OfficeHostOwner
  workspaceRoot: string
  relativePath: string
}
/** `browserPageId` binds the minted grant to the page showing it, exactly as a file grant is. */
export type OfficeSnapshotRequest = OfficeDocumentRequest & { browserPageId: string }
export type OfficeElementRequest = OfficeDocumentRequest & { elementPath: string }
export type OfficeSkillsListRequest = { owner: OfficeHostOwner; workspaceRoot?: string }
export type OfficeSkillsInstallRequest = {
  owner: OfficeHostOwner
  pairs: readonly { skill: string; agent: string }[]
  workspaceRoot?: string
}

/** A preview URL for bytes main holds, plus the grant id the caller must release on tab close. */
export type OfficeSnapshotResult =
  | { ok: true; grantId: string; url: string; kind: OfficeDocKind }
  | { ok: false; code: OfficeErrorCode; detail?: string }
