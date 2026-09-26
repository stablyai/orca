// Shelved diffs travel through the generic git:diff channel as a suffix on the workspace-relative path.
const SHELVED_SUFFIX = /#shelf(view)?(\d+)$/

export type ShelvedDiffTarget = {
  path: string
  changelist: number
  /** True when the shelved file is shown alone, without a diff against the workspace. */
  viewOnly: boolean
}

export function toShelvedDiffPath(path: string, changelist: number, viewOnly: boolean): string {
  return `${path}#shelf${viewOnly ? 'view' : ''}${changelist}`
}

export function parseShelvedDiffPath(filePath: string): ShelvedDiffTarget | null {
  const match = SHELVED_SUFFIX.exec(filePath)
  if (!match) {
    return null
  }
  return {
    path: filePath.slice(0, match.index),
    changelist: Number(match[2]),
    viewOnly: match[1] === 'view'
  }
}
