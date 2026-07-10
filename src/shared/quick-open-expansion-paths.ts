/**
 * Add one Git directory placeholder while removing redundant descendants.
 * The boolean records whether that subtree must preserve symlink leaves.
 */
export function addQuickOpenExpansionPath(
  expansionPaths: Map<string, boolean>,
  relPath: string,
  includeSymlinks: boolean
): void {
  let mergedIncludeSymlinks = includeSymlinks
  for (const [existingPath, existingIncludeSymlinks] of expansionPaths) {
    if (relPath === existingPath || relPath.startsWith(`${existingPath}/`)) {
      expansionPaths.set(existingPath, existingIncludeSymlinks || includeSymlinks)
      return
    }
    if (existingPath.startsWith(`${relPath}/`)) {
      // Why: primary and ignored Git passes can emit overlapping placeholders;
      // the ancestor walk already covers the descendant and must count it once.
      mergedIncludeSymlinks ||= existingIncludeSymlinks
      expansionPaths.delete(existingPath)
    }
  }
  expansionPaths.set(relPath, mergedIncludeSymlinks)
}
