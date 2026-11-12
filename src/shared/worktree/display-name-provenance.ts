import { getRuntimePathBasename } from '../cross-platform-path'

/** A rename with text pins the label; empty text returns it to automatic (branch-derived). */
export function displayNameUpdatePinsLabel(displayName: string | undefined): boolean {
  return Boolean(displayName?.trim())
}

/** The label an unpinned workspace shows: its branch, else its project's name, else its folder. */
export function automaticWorktreeDisplayName(args: {
  branch: string
  projectName: string | undefined
  path: string
}): string {
  return (
    args.branch.replace(/^refs\/heads\//, '') ||
    args.projectName ||
    getRuntimePathBasename(args.path)
  )
}
