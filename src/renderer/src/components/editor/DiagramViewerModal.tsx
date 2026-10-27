import React, { useEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { PanZoomSize } from './pan-zoom-view'
import { PanZoomImageDialog } from './PanZoomImageDialog'

function readSvgImage(svg: string): { xml: string; size: PanZoomSize } | null {
  // HTML-serialized sanitized SVG can contain &nbsp;, which XML image documents reject.
  const element = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')
  const [, , width, height] = (element?.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (!element || !(width > 0 && height > 0)) {
    return null
  }
  return {
    xml: new XMLSerializer().serializeToString(element),
    size: { width, height }
  }
}

function useSvgObjectUrl(xml: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (xml === null) {
      setUrl(null)
      return
    }
    // An image document isolates copied IDs and styles from the original on the page.
    const next = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [xml])
  return url
}

export default function DiagramViewerModal(): React.JSX.Element {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const svg = typeof modalData.svg === 'string' ? modalData.svg : ''
  const background = typeof modalData.background === 'string' ? modalData.background : undefined
  const image = useMemo(() => readSvgImage(svg), [svg])
  const url = useSvgObjectUrl(image?.xml ?? null)

  return (
    <PanZoomImageDialog
      open
      onOpenChange={(open) => !open && closeModal()}
      src={url}
      size={image?.size}
      title={translate('auto.components.editor.DiagramViewerModal.title', 'Diagram')}
      background={background}
    />
  )
}
