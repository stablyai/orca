/**
 * Reads a persisted workspace session for the ghost-tab repro: which (worktree, path) pairs carry
 * the duplicate/mis-owned shapes, and what one session says about the tracked paths. Pure — it
 * never launches anything, so the repro driver next to it stays about driving the app.
 */

const EDITOR_CONTENT_TYPES = new Set(['editor', 'diff', 'conflict-review', 'check-details'])

/** The owner a persisted record names, matching the store's runtimeOwnerKey. */
function ownerKey(file) {
  return file.runtimeEnvironmentId?.trim() || null
}

/**
 * The file path an editor entity id names. A record the heal could not leave unowned restores under
 * `editor:<worktree>:<runtime>:<path>` with every segment percent-encoded, so comparing a tab's
 * entityId to a tracked path verbatim silently misses every healed tab.
 */
export const editorEntityPath = (entityId) => {
  const id = String(entityId)
  const parts = id.split(':')
  if (parts[0] !== 'editor' || parts.length !== 4) {
    return id
  }
  try {
    return decodeURIComponent(parts[3])
  } catch {
    return id
  }
}

/** Why injected as source: page.evaluate ships only the callee's body, so the page needs its own copy. */
export const EDITOR_ENTITY_PATH_INIT_SCRIPT = `window.__editorEntityPath = ${editorEntityPath.toString()}`

function editorTabsByEntity(session, worktreeId) {
  const byEntity = new Map()
  for (const tab of session.unifiedTabs?.[worktreeId] ?? []) {
    if (!EDITOR_CONTENT_TYPES.has(tab.contentType)) {
      continue
    }
    const tabs = byEntity.get(tab.entityId) ?? []
    tabs.push(tab)
    byEntity.set(tab.entityId, tabs)
  }
  return byEntity
}

/**
 * Affected (worktree, path) pairs: more than one OpenFile record, owners that disagree, an editor
 * tab repeated inside one tab group, or a tab with no record left — the shapes that resurrect a
 * closed tab. A tab without a record is the ghost itself, so it must not need a record to be seen.
 */
export function scanWorkspaceSession(session) {
  const affectedByWorktree = new Map()
  for (const [worktreeId, files] of Object.entries(session?.openFilesByWorktree ?? {})) {
    const ownersByPath = new Map()
    for (const file of files) {
      ownersByPath.set(file.filePath, [...(ownersByPath.get(file.filePath) ?? []), ownerKey(file)])
    }
    const tabsByPath = new Map()
    for (const [entityId, tabs] of editorTabsByEntity(session, worktreeId)) {
      const filePath = editorEntityPath(entityId)
      tabsByPath.set(filePath, [...(tabsByPath.get(filePath) ?? []), ...tabs])
      if (!ownersByPath.has(filePath)) {
        ownersByPath.set(filePath, [])
      }
    }
    const affected = []
    for (const [filePath, owners] of ownersByPath) {
      const tabs = tabsByPath.get(filePath) ?? []
      const tabsPerGroup = new Map()
      for (const tab of tabs) {
        tabsPerGroup.set(tab.groupId, (tabsPerGroup.get(tab.groupId) ?? 0) + 1)
      }
      const repeatedInGroup = [...tabsPerGroup.values()].filter((count) => count > 1).length
      const distinctOwners = [...new Set(owners)]
      if (
        owners.length > 1 ||
        distinctOwners.length > 1 ||
        repeatedInGroup > 0 ||
        (owners.length === 0 && tabs.length > 0)
      ) {
        affected.push({
          filePath,
          recordCount: owners.length,
          owners: distinctOwners,
          editorTabCount: tabs.length,
          repeatedInGroup
        })
      }
    }
    if (affected.length > 0) {
      affectedByWorktree.set(worktreeId, affected)
    }
  }
  return affectedByWorktree
}

export function printScanTable(affectedByWorktree) {
  console.error('[heal-repro] affected (worktree, path) pairs:')
  for (const [worktreeId, affected] of affectedByWorktree) {
    console.error(`  ${worktreeId}`)
    for (const entry of affected) {
      const owners = entry.owners.map((owner) => owner ?? 'null').join(',')
      console.error(
        `    records=${entry.recordCount} owners=[${owners}] editorTabs=${entry.editorTabCount}` +
          ` repeatedInGroup=${entry.repeatedInGroup}  ${entry.filePath}`
      )
    }
  }
}

/** Why: a tab id is opaque and may hold a stray `%`, and one bad id must not abort the whole run. */
function safeDecode(id) {
  try {
    return decodeURIComponent(id)
  } catch (error) {
    void error
    return id
  }
}

/** Snapshot of the persisted session for the tracked paths — the same fields the store reader returns. */
export function persistedShape(data, worktreeId, paths) {
  const session = data.workspaceSession ?? {}
  const records = (session.openFilesByWorktree?.[worktreeId] ?? []).filter((file) =>
    paths.includes(file.filePath)
  )
  const allTabs = session.unifiedTabs?.[worktreeId] ?? []
  const tabEntityById = new Map(allTabs.map((tab) => [tab.id, tab.entityId]))
  const tabs = allTabs.filter((tab) => paths.includes(editorEntityPath(tab.entityId)))
  return {
    openFileRecords: records.map((file) => ({
      filePath: file.filePath,
      runtimeEnvironmentId: ownerKey(file)
    })),
    openFileCountByPath: Object.fromEntries(
      paths.map((p) => [p, records.filter((file) => file.filePath === p).length])
    ),
    editorTabsForPaths: tabs.map((tab) => ({
      id: tab.id,
      entityId: tab.entityId,
      executionHostId: tab.executionHostId ?? null
    })),
    totalUnifiedTabsForWorktree: allTabs.length,
    tabGroups: (session.tabGroups?.[worktreeId] ?? []).map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId,
      tabOrderLength: group.tabOrder.length,
      recentTabIdsLength: group.recentTabIds?.length ?? 0,
      // Why entityId first, text match second: the fallback only recovers dangling entries whose id
      // embeds the encoded path (bare-path and composite editor ids); a dangling bare-uuid tab id
      // carries no path and stays invisible here.
      pathReferences: [...group.tabOrder, ...(group.recentTabIds ?? [])]
        .map((id) => {
          const entityId = tabEntityById.get(id)
          return entityId !== undefined
            ? { id, path: editorEntityPath(entityId) }
            : {
                id,
                path: paths.find((p) => safeDecode(id).includes(p)) ?? null,
                dangling: true
              }
        })
        .filter((reference) => paths.includes(reference.path))
    }))
  }
}
