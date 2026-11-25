// Anchor retained panes to each group body so split changes do not reparent heavyweight DOM.

const ANCHOR_PREFIX = '--orca-tab-group-body-'

/** Hex-encode group IDs, including remote path-like IDs, to produce valid CSS dashed identifiers. */
export function tabGroupBodyAnchorName(groupId: string): string {
  const encoded = Array.from(groupId, (char) => char.codePointAt(0)?.toString(16) ?? '').join('-')
  return `${ANCHOR_PREFIX}${encoded || 'empty'}`
}
