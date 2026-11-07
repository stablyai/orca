import { useCallback } from 'react'
import { useAppStore } from '@/store'
import type { RenderedMermaidDiagram } from './MermaidBlock'

/** Opens a rendered diagram in the full-window pan and zoom viewer. */
export function useMermaidDiagramExpand(): (diagram: RenderedMermaidDiagram) => void {
  const openModal = useAppStore((s) => s.openModal)
  return useCallback(
    (diagram: RenderedMermaidDiagram) => openModal('diagram-viewer', diagram),
    [openModal]
  )
}
