// Publish changed shown groups since main’s last acknowledgment so CLI/phone files land in view; null clears absent workspace groups.

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
