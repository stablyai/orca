import {
  canvasDocumentSchema,
  emptyCanvasDocument,
  type CanvasDocument
} from './agent-canvas-document'

export const CANVAS_STORAGE_PREFIX = 'orca.agent-canvas.v1:'

type MountedDocument = {
  read: () => CanvasDocument
  apply: (document: CanvasDocument) => void
}
const mountedDocuments = new Map<string, MountedDocument>()

export function registerCanvasDocument(scope: string, document: MountedDocument): () => void {
  mountedDocuments.set(scope, document)
  return () => {
    if (mountedDocuments.get(scope) === document) {
      mountedDocuments.delete(scope)
    }
  }
}

export function readCanvasDocument(key: string): {
  document: CanvasDocument
  error: string | null
} {
  try {
    const mounted = mountedDocuments.get(key.slice(CANVAS_STORAGE_PREFIX.length))
    const saved = mounted ? null : localStorage.getItem(key)
    return {
      document:
        mounted?.read() ??
        (saved ? canvasDocumentSchema.parse(JSON.parse(saved)) : emptyCanvasDocument()),
      error: null
    }
  } catch {
    return {
      document: emptyCanvasDocument(),
      error: 'This canvas could not be loaded. Its saved data has been preserved.'
    }
  }
}

export function changeCanvasDocument(
  scope: string,
  change: (document: CanvasDocument) => CanvasDocument
): void {
  const current = readCanvasDocument(CANVAS_STORAGE_PREFIX + scope)
  if (current.error) {
    throw new Error(current.error)
  }
  const next = canvasDocumentSchema.parse(change(current.document))
  // Persist before acknowledging an agent's request, including when the canvas is hidden.
  localStorage.setItem(CANVAS_STORAGE_PREFIX + scope, JSON.stringify(next))
  mountedDocuments.get(scope)?.apply(next)
}
