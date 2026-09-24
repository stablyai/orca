import { TAG_GROUP_PREFIX } from '../../../../../../shared/sidebar-list/sections/tag-groups'

export const TAG_DROP_TARGET_ATTR = 'data-workspace-tag-drop-target'

/** The tag section under the pointer, as its section key; null outside any tag section. */
export function getPointerDropTagSection(args: {
  container: HTMLElement
  x: number
  y: number
}): string | null {
  const target = document.elementFromPoint(args.x, args.y)
  if (!(target instanceof Element) || !args.container.contains(target)) {
    return null
  }
  const section = target.closest<HTMLElement>(`[${TAG_DROP_TARGET_ATTR}]`)
  const key =
    section && args.container.contains(section) ? section.getAttribute(TAG_DROP_TARGET_ATTR) : null
  return key?.startsWith(TAG_GROUP_PREFIX) ? key : null
}

/** Drop-target attributes for a header or row that belongs to a tag section; Untagged gets none. */
export function getTagDropTargetProps(sectionKey: string | undefined): Record<string, string> {
  return sectionKey?.startsWith(TAG_GROUP_PREFIX) ? { [TAG_DROP_TARGET_ATTR]: sectionKey } : {}
}
