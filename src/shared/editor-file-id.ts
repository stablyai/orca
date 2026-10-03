/**
 * Editor file identity shared by the renderer's editor slice and the session read path.
 *
 * Why in /shared: stranded-partition adoption builds unified entries for editor files it carries
 * across partitions, and those must carry the id hydration will give the file, or the file restores
 * with no tab to show it.
 */
export function runtimeOwnerKey(runtimeEnvironmentId: string | null | undefined): string | null {
  return runtimeEnvironmentId?.trim() || null
}

export function buildOwnedEditorFileId(
  filePath: string,
  worktreeId: string,
  runtimeEnvironmentId: string | null | undefined
): string {
  const runtimeKey = runtimeOwnerKey(runtimeEnvironmentId) ?? 'local'
  return `editor:${encodeURIComponent(worktreeId)}:${encodeURIComponent(runtimeKey)}:${encodeURIComponent(filePath)}`
}
