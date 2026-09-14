// Shape of an epub.js navigation entry (types/navigation.d.ts NavItem), narrowed
// to the fields the reader's chapter list needs.
export type EpubNavItem = {
  label?: string
  href?: string
  subitems?: EpubNavItem[]
}

export type FlatTocEntry = {
  label: string
  href: string
  depth: number
}

// Flatten epub.js's nested table of contents into a depth-tagged list in reading
// order. Entries without an href are dropped so no row navigates nowhere.
export function flattenEpubToc(toc: EpubNavItem[] | undefined, depth = 0): FlatTocEntry[] {
  if (!toc) {
    return []
  }
  const entries: FlatTocEntry[] = []
  for (const item of toc) {
    const href = item.href?.trim()
    if (href) {
      entries.push({ label: (item.label ?? '').trim(), href, depth })
    }
    if (item.subitems?.length) {
      entries.push(...flattenEpubToc(item.subitems, depth + 1))
    }
  }
  return entries
}
