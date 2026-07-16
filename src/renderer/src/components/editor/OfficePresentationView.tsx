import React, { useEffect, useState } from 'react'
import { FileText, Loader2, Presentation } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { parsePresentationText, type PresentationSlide } from './office-document-parse'
import { resolvePresentationPreviewBuffer } from './office-presentation-preview'

const PPTX_SLOW_RENDER_NOTICE_MS = 10_000

type PptxPreviewer = {
  preview: (buffer: ArrayBuffer) => Promise<unknown> | unknown
  destroy?: () => void
}

function PresentationTextFallback({
  reason,
  slides
}: {
  reason: string | null
  slides: PresentationSlide[]
}): React.JSX.Element {
  return (
    <div className="h-full overflow-auto bg-muted p-6 scrollbar-editor">
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        {reason ? (
          <div className="rounded-md border border-border bg-background px-4 py-3 text-xs text-muted-foreground">
            {reason}
          </div>
        ) : null}
        {slides.map((slide) => (
          <section
            key={slide.number}
            className="aspect-video overflow-auto rounded-md border border-border bg-background p-8 shadow-xs"
          >
            <div className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
              <Presentation className="size-4" />
              {translate('auto.components.editor.OfficeDocumentViewer.slide', 'Slide')}{' '}
              {slide.number}
            </div>
            <div className="space-y-3 text-foreground">
              {slide.paragraphs.map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export function OfficePresentationView({
  buffer,
  contentBase64
}: {
  buffer: ArrayBuffer
  contentBase64: string
}): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const fallbackRequestedRef = React.useRef(false)
  const nativeRequestTokenRef = React.useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rendered, setRendered] = useState(false)
  const [slowRender, setSlowRender] = useState(false)
  const [fallback, setFallback] = useState<{
    reason: string | null
    slides: PresentationSlide[]
  } | null>(null)

  const renderFallback = React.useCallback(
    (reason: string | null): void => {
      fallbackRequestedRef.current = true
      const requestToken = nativeRequestTokenRef.current
      if (requestToken) {
        nativeRequestTokenRef.current = null
        void window.api.powerpointPreview?.cancel({ requestToken })
      }
      hostRef.current?.replaceChildren()
      void parsePresentationText(buffer).then(
        (slides) => setFallback({ reason, slides }),
        (fallbackReason: unknown) => {
          const fallbackMessage =
            fallbackReason instanceof Error ? fallbackReason.message : String(fallbackReason)
          setError(reason ? `${reason} ${fallbackMessage}` : fallbackMessage)
        }
      )
    },
    [buffer]
  )

  useEffect(() => {
    let active = true
    let slowRenderTimer: ReturnType<typeof setTimeout> | null = null
    let slideObserver: MutationObserver | null = null
    let previewer: PptxPreviewer | null = null
    const host = hostRef.current
    if (!host) {
      return
    }
    host.replaceChildren()
    fallbackRequestedRef.current = false
    setError(null)
    setRendered(false)
    setSlowRender(false)
    setFallback(null)
    const requestToken = crypto.randomUUID()
    nativeRequestTokenRef.current = requestToken

    const clearWrapperBackground = (): void => {
      // Why: pptx-preview owns these internal wrappers and otherwise paints an
      // opaque canvas behind PowerPoint's flattened slide images.
      host
        .querySelector<HTMLElement>('.pptx-preview-wrapper')
        ?.style.setProperty('background', 'transparent')
    }

    const markRenderedIfSlideExists = (): boolean => {
      if (host.querySelectorAll('.pptx-preview-slide-wrapper').length === 0) {
        return false
      }
      clearWrapperBackground()
      setRendered(true)
      setSlowRender(false)
      return true
    }

    slideObserver = new MutationObserver(() => {
      if (!active) {
        return
      }
      markRenderedIfSlideExists()
    })
    slideObserver.observe(host, { childList: true, subtree: true })

    slowRenderTimer = setTimeout(() => {
      if (active && !markRenderedIfSlideExists()) {
        setSlowRender(true)
      }
    }, PPTX_SLOW_RENDER_NOTICE_MS)

    void Promise.all([
      resolvePresentationPreviewBuffer(contentBase64, buffer, requestToken),
      import('pptx-preview')
    ]).then(
      ([previewBuffer, { init }]) => {
        if (nativeRequestTokenRef.current === requestToken) {
          nativeRequestTokenRef.current = null
        }
        if (fallbackRequestedRef.current) {
          return
        }
        if (!active) {
          return
        }
        previewer = init(host, { width: 960, height: 540 })
        clearWrapperBackground()
        void Promise.resolve(previewer.preview(previewBuffer)).then(
          () => {
            if (!active) {
              return
            }
            if (markRenderedIfSlideExists()) {
              return
            }
            renderFallback(
              translate(
                'auto.components.editor.OfficeDocumentViewer.renderEmptyFallback',
                'PowerPoint visual preview rendered no slides. Showing extracted slide text instead.'
              )
            )
          },
          (reason: unknown) => {
            if (!active) {
              return
            }
            const message = reason instanceof Error ? reason.message : String(reason)
            renderFallback(
              `${translate(
                'auto.components.editor.OfficeDocumentViewer.renderErrorFallback',
                'PowerPoint visual preview failed. Showing extracted slide text instead.'
              )} ${message}`
            )
          }
        )
      },
      (reason: unknown) => {
        if (!active) {
          return
        }
        const message = reason instanceof Error ? reason.message : String(reason)
        renderFallback(
          `${translate(
            'auto.components.editor.OfficeDocumentViewer.renderLoadFallback',
            'PowerPoint visual preview could not load. Showing extracted slide text instead.'
          )} ${message}`
        )
      }
    )

    return () => {
      active = false
      if (nativeRequestTokenRef.current === requestToken) {
        nativeRequestTokenRef.current = null
        void window.api.powerpointPreview?.cancel({ requestToken })
      }
      if (slowRenderTimer) {
        clearTimeout(slowRenderTimer)
      }
      slideObserver?.disconnect()
      previewer?.destroy?.()
      host.replaceChildren()
    }
  }, [buffer, contentBase64, renderFallback])

  if (fallback) {
    return <PresentationTextFallback reason={fallback.reason} slides={fallback.slides} />
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-auto bg-muted p-6 scrollbar-editor">
      {!rendered ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-md border border-border bg-background px-4 py-3 text-center shadow-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />
              {translate(
                'auto.components.editor.OfficeDocumentViewer.renderingPresentation',
                'Rendering presentation...'
              )}
            </div>
            {slowRender ? (
              <>
                <div className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.editor.OfficeDocumentViewer.stillRenderingPresentation',
                    'This deck is still rendering visuals.'
                  )}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    renderFallback(
                      translate(
                        'auto.components.editor.OfficeDocumentViewer.manualTextFallback',
                        'Showing extracted slide text.'
                      )
                    )
                  }
                >
                  <FileText className="size-3.5" />
                  {translate(
                    'auto.components.editor.OfficeDocumentViewer.showExtractedText',
                    'Show extracted text'
                  )}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div ref={hostRef} className="mx-auto min-h-[540px] w-[960px] max-w-full" />
    </div>
  )
}
