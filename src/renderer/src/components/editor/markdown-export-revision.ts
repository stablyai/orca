const documentRevisions = new WeakMap<Element, () => unknown>()

export function registerMarkdownExportRevision(
  root: Element,
  readRevision: () => unknown
): () => void {
  documentRevisions.set(root, readRevision)
  return () => {
    if (documentRevisions.get(root) === readRevision) {
      documentRevisions.delete(root)
    }
  }
}

export function captureMarkdownExportRevision(root: Element): () => boolean {
  const readRevision = documentRevisions.get(root)
  const revision = readRevision?.()
  return () =>
    documentRevisions.get(root) === readRevision &&
    (!readRevision || (revision != null && readRevision() === revision))
}
