/** A known fact path: a leaf, a branch, a list of items, or an open namespace. */
// Why `object`: a recursive alias through Record collapses to any; branches are read by guard.
type PathNode = true | 'open' | object

const leaves = (...names: string[]): Record<string, true> =>
  Object.fromEntries(names.map((name) => [name, true as const]))

export const CARD_AGENT_FACT_PATHS = leaves('title', 'agent', 'state', 'message', 'since')

/** Every path a template may read. Kept beside WorkspaceCardFacts; a test checks they match. */
export const CARD_FACT_PATHS: Readonly<Record<string, PathNode>> = {
  ws: leaves(
    'id',
    'name',
    'title',
    'kind',
    'path',
    'branch',
    'identity',
    'isMain',
    'isSparse',
    'detachedHead',
    'isPinned',
    'isUnread',
    'isDeleting',
    'isRenaming',
    'hasRenameError',
    'removalError',
    'comment'
  ),
  repo: leaves('id', 'name', 'ssh'),
  host: leaves('kind', 'contextLabel', 'runtimeDisconnected'),
  git: {
    conflictOperation: true,
    remoteBranchConflict: leaves('remote', 'branch'),
    cacheTimerActive: true
  },
  review: leaves('provider', 'number', 'title', 'state', 'status', 'url'),
  checks: leaves('total', 'passing', 'failing', 'pending'),
  links: leaves('count', 'issue', 'linearIssue', 'jiraIssue'),
  provenance: leaves('automation', 'cli'),
  ports: leaves('count'),
  lineage: leaves('childCount', 'collapsed', 'toggleable'),
  place: leaves(
    'isActive',
    'inPinnedSection',
    'hideRepoBadge',
    'showProjectName',
    'affiliateList',
    'deleteQuickAction'
  ),
  options: {
    style: true,
    agentRows: true,
    show: leaves(
      'status',
      'unread',
      'ci',
      'branch',
      'issue',
      'linearIssue',
      'jiraIssue',
      'pr',
      'automation',
      'cli',
      'comment',
      'ports',
      'inlineAgents',
      'host'
    )
  },
  env: leaves('projectGroups'),
  activity: {
    status: true,
    needsInput: true,
    counts: leaves('working', 'blocked', 'done', 'idle'),
    agents: { listOf: CARD_AGENT_FACT_PATHS }
  },
  fields: 'open',
  cardOptions: 'open',
  vars: 'open'
}

function childOf(node: object, key: string): PathNode | null {
  if (!Object.hasOwn(node, key)) {
    return null
  }
  const child: unknown = Reflect.get(node, key)
  return child === true || child === 'open' || (typeof child === 'object' && child !== null)
    ? child
    : null
}

function isList(node: PathNode): node is { readonly listOf: PathNode } {
  return typeof node === 'object' && Object.hasOwn(node, 'listOf')
}

/** The list a path names, for `Each`; null when it names no list. */
export function cardFactListItems(
  segments: readonly string[],
  item: PathNode | null
): PathNode | null {
  const node = resolve(segments, item)
  return node !== null && isList(node) ? childOf(node, 'listOf') : null
}

function resolve(segments: readonly string[], item: PathNode | null): PathNode | null {
  const [root, ...rest] = segments
  let node: PathNode | undefined =
    root === 'item'
      ? (item ?? undefined)
      : root && Object.hasOwn(CARD_FACT_PATHS, root)
        ? CARD_FACT_PATHS[root]
        : undefined
  for (const segment of rest) {
    if (node === undefined || node === true) {
      return null
    }
    if (node === 'open') {
      return 'open'
    }
    if (isList(node)) {
      return null
    }
    node = childOf(node, segment) ?? undefined
  }
  return node ?? null
}

/** Why a template may not read this path, or null when it may. `item` is the current `Each` item. */
export function cardFactPathIssue(
  segments: readonly string[],
  item: PathNode | null
): string | null {
  return resolve(segments, item) === null ? `unknown fact ${segments.join('.')}` : null
}

export type CardFactPathNode = PathNode
