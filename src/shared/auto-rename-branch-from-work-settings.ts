import type { GlobalSettings } from './types'

type AutoRenameBranchFromWorkSettings = Pick<
  GlobalSettings,
  'autoRenameBranchFromWork' | 'autoRenameBranchFromWorkDefaultedOn'
>

export function normalizeAutoRenameBranchFromWorkDefaultOn(
  settings: Partial<AutoRenameBranchFromWorkSettings> | undefined,
  options: { preserveExplicitValue?: boolean } = {}
): AutoRenameBranchFromWorkSettings {
  const defaultedOn =
    settings?.autoRenameBranchFromWorkDefaultedOn === true || options.preserveExplicitValue === true

  return {
    // Why: old persisted profiles may contain the former default `false`;
    // only guarded profiles or live user updates represent an intentional opt-out.
    autoRenameBranchFromWork: defaultedOn ? (settings?.autoRenameBranchFromWork ?? true) : true,
    autoRenameBranchFromWorkDefaultedOn: true
  }
}
