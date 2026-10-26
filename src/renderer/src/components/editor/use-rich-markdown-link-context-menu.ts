import { useEffect, useRef } from 'react'
import { openRoutedHttpLink } from '@/lib/http-link-destinations'
import { parseHttpUrl } from '../../../../shared/external-browser-types'
import type { RichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'
import {
  resolveRichMarkdownOrcaLinkTarget,
  type RichMarkdownOrcaLinkTarget
} from './rich-markdown-editor-click-routing'

/** Tells main's native menu whether a right-clicked link can open in Orca Browser, and opens it there. */
export function useRichMarkdownLinkContextMenu(
  editor: { view: { dom: HTMLElement } } | null,
  linkContext: Pick<RichMarkdownHtmlSuperscriptLinkContext, 'getSnapshot'>
): void {
  const capturedTargetRef = useRef<RichMarkdownOrcaLinkTarget | null>(null)

  useEffect(() => {
    if (!editor) {
      return
    }
    const editorDom = editor.view.dom
    const captureTarget = (event: MouseEvent): void => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
      const url =
        anchor && editorDom.contains(anchor) ? parseHttpUrl(anchor.getAttribute('href')) : null
      const target = resolveRichMarkdownOrcaLinkTarget(url, event, linkContext.getSnapshot())
      capturedTargetRef.current = target
      window.api.ui.setRichMarkdownContextMenuLinkTarget(
        target ? { x: target.x, y: target.y } : null
      )
    }
    const unsubscribe = window.api.ui.onRichMarkdownContextCommand((payload) => {
      if (payload.command !== 'open-link-in-orca-browser') {
        return
      }
      const target = capturedTargetRef.current
      capturedTargetRef.current = null
      if (!target || payload.x !== target.x || payload.y !== target.y) {
        return
      }
      openRoutedHttpLink(target.url, {
        worktreeId: target.worktreeId,
        sourceOwner: target.sourceOwner,
        forceDestination: 'orca'
      })
    })
    editorDom.addEventListener('contextmenu', captureTarget)
    return () => {
      editorDom.removeEventListener('contextmenu', captureTarget)
      unsubscribe()
    }
  }, [editor, linkContext])
}
