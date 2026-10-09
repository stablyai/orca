import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  TAB_CLUSTER_COLORS,
  type TabCluster,
  type TabClusterColor,
  type TabGroup
} from '../../../../../shared/tab-types'

export function isTabClusterColor(value: unknown): value is TabClusterColor {
  return TAB_CLUSTER_COLORS.some((color) => color === value)
}

export function createTabClusterId(): string {
  return createBrowserUuid()
}

export function normalizeTabClusters(args: {
  tabOrder: readonly string[]
  clusters: readonly TabCluster[] | undefined
  pinnedTabIds: ReadonlySet<string>
}): TabCluster[] | undefined {
  const { tabOrder, clusters, pinnedTabIds } = args
  if (!clusters?.length) {
    return undefined
  }

  const positions = new Map(tabOrder.map((id, index) => [id, index]))
  const owners = new Map<string, number>()
  clusters.forEach((cluster, index) => {
    for (const id of cluster.tabIds) {
      if (positions.has(id) && !pinnedTabIds.has(id) && !owners.has(id)) {
        owners.set(id, index)
      }
    }
  })
  for (let index = 1; index < tabOrder.length - 1; index++) {
    const id = tabOrder[index]
    if (owners.has(id) || pinnedTabIds.has(id)) {
      continue
    }
    const left = owners.get(tabOrder[index - 1])
    if (left !== undefined && left === owners.get(tabOrder[index + 1])) {
      owners.set(id, left)
    }
  }

  const longestRuns: string[][] = clusters.map(() => [])
  let run: string[] = []
  let runOwner: number | undefined
  const finishRun = (): void => {
    if (runOwner !== undefined && run.length > longestRuns[runOwner].length) {
      longestRuns[runOwner] = run
    }
  }
  for (const id of tabOrder) {
    const owner = owners.get(id)
    if (owner !== runOwner) {
      finishRun()
      run = []
      runOwner = owner
    }
    if (owner !== undefined) {
      run.push(id)
    }
  }
  finishRun()

  let changed = false
  const normalized: TabCluster[] = []
  clusters.forEach((cluster, index) => {
    const tabIds = longestRuns[index]
    if (!tabIds.length) {
      changed = true
      return
    }
    const name = cluster.name.trim()
    const color = isTabClusterColor(cluster.color) ? cluster.color : 'grey'
    const collapsed = Boolean(cluster.collapsed)
    const shownTabId =
      collapsed && cluster.shownTabId !== undefined && tabIds.includes(cluster.shownTabId)
        ? cluster.shownTabId
        : undefined
    if (
      name === cluster.name &&
      color === cluster.color &&
      collapsed === cluster.collapsed &&
      shownTabId === cluster.shownTabId &&
      (shownTabId !== undefined || !Object.hasOwn(cluster, 'shownTabId')) &&
      tabIds.length === cluster.tabIds.length &&
      tabIds.every((id, memberIndex) => id === cluster.tabIds[memberIndex])
    ) {
      normalized.push(cluster)
    } else {
      changed = true
      const nextCluster = { ...cluster, name, color, collapsed, tabIds }
      if (shownTabId === undefined) {
        delete nextCluster.shownTabId
      }
      normalized.push(nextCluster)
    }
  })
  if (!normalized.length) {
    return undefined
  }
  if (changed) {
    return normalized
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Normal form is unchanged; preserving this array's identity is part of the model contract.
  return clusters as TabCluster[]
}

export function getTabClusterForTab(
  clusters: readonly TabCluster[] | undefined,
  tabId: string
): TabCluster | null {
  return clusters?.find((cluster) => cluster.tabIds.includes(tabId)) ?? null
}

export function getTabClusterInsertionIndex(
  tabOrder: readonly string[],
  clusters: readonly TabCluster[] | undefined,
  index: number,
  joiningClusterId?: string | null
): number {
  const insertionIndex = Math.max(0, Math.min(index, tabOrder.length))
  for (const cluster of clusters ?? []) {
    if (cluster.id === joiningClusterId) {
      continue
    }
    const start = tabOrder.indexOf(cluster.tabIds[0])
    const end = tabOrder.indexOf(cluster.tabIds.at(-1) ?? '') + 1
    if (start !== -1 && insertionIndex > start && insertionIndex < end) {
      // Why: the nearest edge preserves nonmembership with minimal displacement; ties go before.
      return insertionIndex - start <= end - insertionIndex ? start : end
    }
  }
  return insertionIndex
}

export function rekeyTabClusterMembers(
  clusters: readonly TabCluster[] | undefined,
  rekey: ReadonlyMap<string, string>
): TabCluster[] | undefined {
  if (!clusters?.length) {
    return undefined
  }
  let changed = false
  const next = clusters.map((cluster) => {
    const tabIds = cluster.tabIds.map((id) => rekey.get(id) ?? id)
    const shownTabId =
      cluster.shownTabId === undefined
        ? undefined
        : (rekey.get(cluster.shownTabId) ?? cluster.shownTabId)
    if (
      shownTabId === cluster.shownTabId &&
      tabIds.every((id, index) => id === cluster.tabIds[index])
    ) {
      return cluster
    }
    changed = true
    const nextCluster = { ...cluster, tabIds }
    if (shownTabId !== undefined) {
      nextCluster.shownTabId = shownTabId
    }
    return nextCluster
  })
  if (changed) {
    return next
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: No member changed; preserving the input array's identity is required by the model contract.
  return clusters as TabCluster[]
}

export function normalizeTabGroupClusters(
  group: TabGroup,
  pinnedTabIds: ReadonlySet<string>
): TabGroup {
  const tabClusters = normalizeTabClusters({
    tabOrder: group.tabOrder,
    clusters: group.tabClusters,
    pinnedTabIds
  })
  if (tabClusters === group.tabClusters && (tabClusters || !Object.hasOwn(group, 'tabClusters'))) {
    return group
  }
  const next = { ...group }
  delete next.tabClusters
  if (tabClusters) {
    next.tabClusters = tabClusters
  }
  return next
}

export function applyTransferredTabClusterMembership(
  group: TabGroup,
  tabIds: readonly string[],
  clusterId: string | null | undefined,
  pinnedTabIds: ReadonlySet<string>
): TabGroup {
  if (!group.tabClusters) {
    return normalizeTabGroupClusters(group, pinnedTabIds)
  }
  const movedIds = new Set(tabIds)
  const tabClusters = group.tabClusters.map((cluster) => {
    const remaining = cluster.tabIds.filter((id) => !movedIds.has(id))
    const joining = cluster.id === clusterId ? tabIds.filter((id) => !pinnedTabIds.has(id)) : []
    if (remaining.length === cluster.tabIds.length && !joining.length) {
      return cluster
    }
    return { ...cluster, tabIds: [...remaining, ...joining] }
  })
  return normalizeTabGroupClusters({ ...group, tabClusters }, pinnedTabIds)
}

export function mergeTabClusterRecords(
  destination: readonly TabCluster[] | undefined,
  incoming: readonly TabCluster[] | undefined
): TabCluster[] | undefined {
  if (!destination?.length && !incoming?.length) {
    return undefined
  }
  const usedIds = new Set(destination?.map((cluster) => cluster.id))
  const merged = [...(destination ?? [])]
  for (const cluster of incoming ?? []) {
    let id = cluster.id
    while (usedIds.has(id)) {
      id = createTabClusterId()
    }
    usedIds.add(id)
    merged.push(id === cluster.id ? cluster : { ...cluster, id })
  }
  return merged
}
