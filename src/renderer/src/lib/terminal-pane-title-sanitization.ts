import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'

function collectLeafIds(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
}

function normalizeTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function isSyntheticSinglePaneTitleForLabels(
  title: string | null | undefined,
  labels: readonly (string | null | undefined)[]
): boolean {
  const normalized = normalizeTitle(title)
  if (!normalized) {
    return true
  }
  if (/^Terminal \d+$/.test(normalized)) {
    return true
  }
  const normalizedLabels = labels
    .map(normalizeTitle)
    .filter((value): value is string => value !== null)
  return normalizedLabels.includes(normalized)
}

export function isSyntheticSinglePaneTitle(
  title: string | null | undefined,
  tab: TerminalTab
): boolean {
  return isSyntheticSinglePaneTitleForLabels(title, [tab.title, tab.defaultTitle, tab.customTitle])
}

export function sanitizeTerminalLayoutPaneTitlesForLabels(
  layout: TerminalLayoutSnapshot,
  labels: readonly (string | null | undefined)[]
): TerminalLayoutSnapshot {
  const titles = layout.titlesByLeafId
  if (!titles) {
    return layout
  }

  const titleEntries = Object.entries(titles)
  const leafIds = collectLeafIds(layout.root)
  const isSinglePaneLayout =
    leafIds.length <= 1 &&
    titleEntries.length <= 1 &&
    (leafIds.length === 0 || titleEntries.length === 0 || leafIds.includes(titleEntries[0][0]))

  if (!isSinglePaneLayout) {
    return layout
  }

  const nextTitleEntries = titleEntries.filter(
    ([, title]) => !isSyntheticSinglePaneTitleForLabels(title, labels)
  )
  if (nextTitleEntries.length === titleEntries.length) {
    return layout
  }

  const { titlesByLeafId: _removedSyntheticTitles, ...layoutWithoutTitles } = layout
  return nextTitleEntries.length > 0
    ? { ...layoutWithoutTitles, titlesByLeafId: Object.fromEntries(nextTitleEntries) }
    : layoutWithoutTitles
}

export function sanitizeTerminalLayoutPaneTitles(
  layout: TerminalLayoutSnapshot,
  tab: TerminalTab
): TerminalLayoutSnapshot {
  return sanitizeTerminalLayoutPaneTitlesForLabels(layout, [
    tab.title,
    tab.defaultTitle,
    tab.customTitle
  ])
}
