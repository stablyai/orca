// The window's active tab group per workspace, a view fact main opens CLI and phone files into:
// only what changed since main last accepted it, null for a workspace that no longer shows one.

export function changedActiveGroups(
  current: Readonly<Record<string, string>>,
  published: Readonly<Record<string, string>>
): Record<string, string | null> | undefined {
  const changed: Record<string, string | null> = {}
  for (const [workspace, groupId] of Object.entries(current)) {
    if (published[workspace] !== groupId) {
      changed[workspace] = groupId
    }
  }
  for (const workspace of Object.keys(published)) {
    if (!(workspace in current)) {
      changed[workspace] = null
    }
  }
  return Object.keys(changed).length > 0 ? changed : undefined
}
