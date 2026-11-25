import type { JiraProjectReference } from '../../../../../../shared/jira/jira-project-reference'

// The default is kept with the pick so a later repo default change in Settings wins again.
export type JiraProjectOverride = {
  project: JiraProjectReference | null
  defaultProject: JiraProjectReference | null
}

// Session memory: picks survive leaving the Tasks view but not an app restart.
const overrides = new Map<string, JiraProjectOverride>()

export function readJiraProjectOverrides(): ReadonlyMap<string, JiraProjectOverride> {
  return new Map(overrides)
}

export function writeJiraProjectOverride(
  scopeKey: string,
  override: JiraProjectOverride
): ReadonlyMap<string, JiraProjectOverride> {
  overrides.set(scopeKey, override)
  return readJiraProjectOverrides()
}
