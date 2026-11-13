import type { CloudReposRetry } from './ProjectComboboxCloudUnavailable'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import type { ProjectComboboxAddProjectMenu } from './ProjectComboboxAddProjectOption'

export type ProjectComboboxProps = {
  options: readonly NewWorkspaceProjectOption[]
  value: string | null
  onValueChange: (projectId: string) => void
  onValueSelected?: (projectId: string) => void
  onAddProject?: () => void
  addProjectMenu?: ProjectComboboxAddProjectMenu
  placeholder?: string
  triggerClassName?: string
  invalid?: boolean
  /**
   * `warning`: a fixable precondition (Orca Cloud waiting for a GitHub repository), ringed amber
   * rather than red; still aria-invalid for screen readers. Defaults to `error`.
   */
  invalidTone?: 'error' | 'warning'
  describedBy?: string
  /** D4: GitHub repositories with no clone here, listed while Orca Cloud is the Run on target. */
  cloudRepos?: readonly OrcaCloudGitHubRepository[] | null
  /** The picked cloud-only repository (owner/name); it replaces the project in the field. */
  cloudRepoValue?: string | null
  onCloudRepoSelected?: (fullName: string) => void
  onMoreCloudAccess?: () => void
  /** Present while GitHub has more repositories than are listed. */
  onShowMoreCloudRepos?: (() => void) | null
  /** GH-LIST-MISSING: GitHub's list couldn't be read; the section says so with Retry. */
  cloudReposRetry?: CloudReposRetry | null
  /** Bumped to open the list at its cloud-only section ("Choose a GitHub repository"). */
  openSignal?: number
  /**
   * Bumped to move focus here quietly (RR-c1: a stopped Create points at the field's error): no
   * path tooltip on that focus, since the error is already speaking. Hover and Tab still show it.
   */
  focusSignal?: number
}

/** The field's invalid ring: red for an error, amber for a fixable precondition (glossary). */
export function projectFieldInvalidClass(tone: 'error' | 'warning'): string {
  return tone === 'warning'
    ? 'border-status-warning ring-status-warning/20 focus-within:border-status-warning focus-within:ring-status-warning/40 dark:ring-status-warning/40'
    : 'border-destructive ring-destructive/20 focus-within:border-destructive focus-within:ring-destructive/40 dark:ring-destructive/40'
}
