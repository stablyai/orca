import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { assertClipboardImageBase64LengthWithinLimit } from '../../../../shared/clipboard-image'
import { translate } from '@/i18n/i18n'
import { MermaidDiagramToolbarButton } from './MermaidDiagramToolbarButton'
import { renderDiagramSvgToPngDataUrl } from './mermaid-diagram-png'
import type { DiagramSize } from './mermaid-diagram-viewport'

const COPIED_FEEDBACK_MS = 2000

type MermaidDiagramCopyPngButtonProps = {
  /** Returns the rendered diagram SVG, its natural size, and the surface color to paint behind it. */
  getDiagram: () => { svg: SVGSVGElement; size: DiagramSize; backgroundColor: string } | null
}

export function MermaidDiagramCopyPngButton({
  getDiagram
}: MermaidDiagramCopyPngButtonProps): React.JSX.Element {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  // Why: rasterizing and the clipboard IPC can finish after the viewer closes.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  const copy = useCallback(async () => {
    const diagram = getDiagram()
    if (!diagram || copying) {
      return
    }
    setCopying(true)
    try {
      const dataUrl = await renderDiagramSvgToPngDataUrl(
        diagram.svg,
        diagram.size,
        diagram.backgroundColor
      )
      // Why: main drops oversized images silently, so reject here to report it.
      assertClipboardImageBase64LengthWithinLimit(dataUrl.length - dataUrl.indexOf(',') - 1)
      await window.api.ui.writeClipboardImage(dataUrl)
      if (!mountedRef.current) {
        return
      }
      setCopied(true)
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current)
      }
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null
        setCopied(false)
      }, COPIED_FEEDBACK_MS)
    } catch {
      toast.error(
        translate(
          'auto.components.editor.MermaidDiagramLightbox.copyFailed',
          "Couldn't copy the diagram as an image"
        )
      )
    } finally {
      if (mountedRef.current) {
        setCopying(false)
      }
    }
  }, [copying, getDiagram])

  return (
    <MermaidDiagramToolbarButton
      label={
        copied
          ? translate('auto.components.editor.MermaidDiagramLightbox.copied', 'Copied')
          : translate('auto.components.editor.MermaidDiagramLightbox.copyPng', 'Copy as PNG')
      }
      disabled={copying}
      onClick={() => void copy()}
    >
      {copied ? <Check /> : <Copy />}
    </MermaidDiagramToolbarButton>
  )
}
