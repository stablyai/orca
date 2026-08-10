/**
 * Resolves the relationship targets that stitch an OPC package together.
 *
 * Why not a path library: part names are always `/`-separated inside the
 * package, independent of the host platform, so Node's `path` would corrupt
 * them on Windows.
 */
export function resolveXlsxPartPath(sourcePartPath: string, target: string): string {
  // Why: an absolute target is package-rooted, not filesystem-rooted.
  if (target.startsWith('/')) {
    return normalizeSegments(target.slice(1).split('/'))
  }
  const sourceSegments = sourcePartPath.split('/')
  sourceSegments.pop()
  return normalizeSegments([...sourceSegments, ...target.split('/')])
}

/** The `_rels` part that holds the relationships declared by `partPath`. */
export function resolveXlsxRelationshipsPartPath(partPath: string): string {
  const segments = partPath.split('/')
  const partName = segments.pop() ?? ''
  return [...segments, '_rels', `${partName}.rels`].join('/')
}

/**
 * Resolves a `Target` read from a `_rels` part.
 *
 * Why not resolve against the rels part itself: a relationship target is
 * relative to the part that *owns* the relationships, not to the `_rels` folder
 * the file sits in. `xl/_rels/workbook.xml.rels` declaring
 * `worksheets/sheet1.xml` means `xl/worksheets/sheet1.xml`, and the package
 * relationships in `_rels/.rels` are relative to the package root.
 */
export function resolveXlsxRelationshipTargetPath(
  relationshipsPartPath: string,
  target: string
): string {
  return resolveXlsxPartPath(resolveXlsxRelationshipsOwnerPath(relationshipsPartPath), target)
}

function resolveXlsxRelationshipsOwnerPath(relationshipsPartPath: string): string {
  const segments = relationshipsPartPath.split('/')
  const relationshipsFileName = segments.pop() ?? ''
  if (segments.at(-1) === '_rels') {
    segments.pop()
  }
  return [...segments, relationshipsFileName.replace(/\.rels$/, '')].join('/')
}

function normalizeSegments(segments: string[]): string {
  const resolved: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      resolved.pop()
      continue
    }
    resolved.push(segment)
  }
  return resolved.join('/')
}
