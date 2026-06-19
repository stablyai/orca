const LAZY_MODAL_IDS = [
  'quick-open',
  'worktree-palette',
  'workspace-cleanup',
  'setup-guide',
  'feature-wall',
  'feature-tips'
] as const

export type LazyModalId = (typeof LAZY_MODAL_IDS)[number]

const LAZY_MODAL_ID_SET = new Set<string>(LAZY_MODAL_IDS)

export function isLazyModalId(value: string): value is LazyModalId {
  return LAZY_MODAL_ID_SET.has(value)
}

export function resolveMountedLazyModalIds(
  activeModal: string,
  mountedIds: ReadonlySet<LazyModalId>
): ReadonlySet<LazyModalId> {
  if (!isLazyModalId(activeModal) || mountedIds.has(activeModal)) {
    return mountedIds
  }
  return new Set([...mountedIds, activeModal])
}
