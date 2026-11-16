import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import type { FileDiffMetadata, PostRenderPhase } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { getDiffOverviewGeometry, PierreDiffOverviewContext } from './pierre-diff-overview'
import type { PierreDiffAnnotationData } from './pierre-diff-comment-annotations'

export function usePierreDiffOverview(
  key: string,
  fileDiff: FileDiffMetadata,
  editorRef: React.RefObject<Editor<'file-diff', PierreDiffAnnotationData, undefined> | null>,
  layout: string
) {
  const overview = useContext(PierreDiffOverviewContext)
  const active = useRef<{ node: HTMLElement; instance: PierreDiffInstance } | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const dirty = useRef(false)
  const version = useRef<number | undefined>(undefined)
  const refresh = useCallback(() => {
    const current = active.current
    if (!overview || !current || !current.node.scrollHeight) {
      return
    }
    const state = editorRef.current?.getEditState()
    const diff = state ? { ...fileDiff, hunks: state.diffSession.hunks } : fileDiff
    const row = current.node.closest<HTMLElement>('[data-index]')
    const inset = row
      ? current.node.getBoundingClientRect().top - row.getBoundingClientRect().top
      : current.node.offsetTop
    version.current = current.instance.layoutVersion
    overview.publish(key, {
      inset,
      layout,
      ...getDiffOverviewGeometry(diff, current.instance, current.node.scrollHeight),
      original: fileDiff.deletionLines.join(''),
      modified:
        editorRef.current?.getEditState()?.document.getText() ?? fileDiff.additionLines.join('')
    })
  }, [overview, key, fileDiff, editorRef, layout])
  const refreshRef = useRef(refresh)
  useLayoutEffect(() => {
    refreshRef.current = refresh
    refresh()
  }, [refresh, layout])
  useLayoutEffect(() => () => observer.current?.disconnect(), [])
  const onPostRender = useCallback(
    (node: HTMLElement, phase: PostRenderPhase, instance: PierreDiffInstance) => {
      if (!overview) {
        return
      }
      if (phase === 'unmount') {
        observer.current?.disconnect()
        active.current = null
      } else if (active.current?.node !== node) {
        observer.current?.disconnect()
        active.current = { node, instance }
        observer.current = new ResizeObserver(() => refreshRef.current())
        observer.current.observe(node)
        refreshRef.current()
      } else if (dirty.current || version.current !== instance.layoutVersion) {
        dirty.current = false
        refreshRef.current()
      }
    },
    [overview]
  )
  const onEditChange = useCallback(() => {
    dirty.current = true
  }, [])
  return { onPostRender, onEditChange }
}
