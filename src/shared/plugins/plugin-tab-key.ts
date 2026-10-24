import { isPluginManifestId, isSafePluginId } from './plugin-id-format'

// Pure boot-path predicates avoid pulling Zod and manifest schemas into renderer sidebar startup.

/** Canonical install identity: `<publisher>.<id>` (also the install dir name). */
export function isQualifiedPluginKey(value: string): boolean {
  const parts = value.split('.')
  if (parts.length !== 2) {
    return false
  }
  return isSafePluginId(parts[0]!) && isSafePluginId(parts[1]!)
}

/** Sidebar tab key for a plugin panel: `plugin:<publisher>.<id>/<panelId>`. */
export function pluginPanelTabKey(qualifiedKey: string, panelId: string): `plugin:${string}` {
  return `plugin:${qualifiedKey}/${panelId}`
}

export function isPluginPanelTabKey(tab: string): tab is `plugin:${string}` {
  if (!tab.startsWith('plugin:')) {
    return false
  }
  const rest = tab.slice('plugin:'.length)
  const [qualifiedKey, panelId, ...extra] = rest.split('/')
  return (
    extra.length === 0 &&
    !!qualifiedKey &&
    !!panelId &&
    isQualifiedPluginKey(qualifiedKey) &&
    isPluginManifestId(panelId)
  )
}
