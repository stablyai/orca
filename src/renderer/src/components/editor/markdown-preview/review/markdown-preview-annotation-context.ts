import { createContext, useContext } from 'react'
import type { MarkdownPreviewAnnotationRenderers } from './use-markdown-preview-annotation-renderers'

export const MarkdownPreviewAnnotationContext =
  createContext<MarkdownPreviewAnnotationRenderers | null>(null)

export function useMarkdownPreviewAnnotations(): MarkdownPreviewAnnotationRenderers {
  const annotations = useContext(MarkdownPreviewAnnotationContext)
  if (!annotations) {
    throw new Error('Markdown preview blocks must render inside MarkdownPreviewAnnotationContext')
  }
  return annotations
}
