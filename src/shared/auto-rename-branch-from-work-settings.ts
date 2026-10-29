import type { GlobalSettings } from './global-settings-types'

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
    // Legacy false defaults are not intentional opt-outs; require guarded profiles or explicit live updates.
    autoRenameBranchFromWork: defaultedOn ? (settings?.autoRenameBranchFromWork ?? true) : true,
    autoRenameBranchFromWorkDefaultedOn: true
  }
}
