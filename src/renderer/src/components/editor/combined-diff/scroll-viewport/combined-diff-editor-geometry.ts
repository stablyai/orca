import type { editor } from 'monaco-editor'
import type { DiffSemanticPoint, DiffViewportItem } from './combined-diff-viewport-owner'
import type { DiffNavigationCommand } from './combined-diff-viewport-anchor'

export type CombinedEditorGeometry = {
  readonly item: DiffViewportItem
  readonly identity: string
  readonly onUnbind: Set<() => void>
  registerZone(id: string, node: HTMLElement, controls: () => readonly HTMLElement[]): () => void
  measureZone(id: string, node: HTMLElement, measure: () => boolean): boolean
  zonePoint(
    id: string,
    node: HTMLElement,
    controls: () => readonly HTMLElement[]
  ): DiffSemanticPoint | null
}
const bindings = new WeakMap<editor.ICodeEditor, CombinedEditorGeometry>()
const combinedEditors = new WeakSet<editor.ICodeEditor>()

export function registerCombinedEditorGeometry(
  editor: editor.ICodeEditor,
  geometry: CombinedEditorGeometry
): () => void {
  bindings.set(editor, geometry)
  combinedEditors.add(editor)
  return () => {
    if (bindings.get(editor) === geometry) {
      bindings.delete(editor)
    }
  }
}

export function isCombinedEditorBindingCurrent(
  editor: editor.ICodeEditor,
  identity?: string
): boolean {
  const binding = bindings.get(editor)
  return !combinedEditors.has(editor) || (binding !== undefined && binding.identity === identity)
}

export function registerCombinedCommentZone(
  editor: editor.ICodeEditor,
  id: string,
  node: HTMLElement,
  controls: () => readonly HTMLElement[]
): () => void {
  return bindings.get(editor)?.registerZone(id, node, controls) ?? (() => {})
}

export function measureCombinedCommentZone(
  editor: editor.ICodeEditor,
  id: string,
  node: HTMLElement,
  measure: () => boolean
): boolean {
  const geometry = bindings.get(editor)
  return geometry
    ? geometry.measureZone(id, node, measure)
    : !combinedEditors.has(editor) && measure()
}

export function onCombinedEditorUnbind(
  editor: editor.ICodeEditor,
  cleanup: () => void
): () => void {
  const geometry = bindings.get(editor)
  let active = true
  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    geometry?.onUnbind.delete(dispose)
    cleanup()
  }
  geometry?.onUnbind.add(dispose)
  return dispose
}

export function invalidateCombinedEditorGeometry(editor: editor.ICodeEditor): void {
  const geometry = bindings.get(editor)
  if (geometry) {
    geometry.item.owner.invalidate(geometry.item)
  }
}

export function releaseCombinedEditorNavigation(editor: editor.ICodeEditor): void {
  const geometry = bindings.get(editor)
  if (geometry) {
    geometry.item.owner.releaseItemNavigation(geometry.item)
  }
}

export function scrollCombinedEditorBy(editor: editor.ICodeEditor, delta: number): boolean {
  const geometry = bindings.get(editor)
  if (!geometry) {
    return false
  }
  geometry.item.owner.input(delta)
  return true
}

export function revealCombinedCommentZone(args: {
  editor: editor.ICodeEditor
  id: string
  node: HTMLElement
  controls: () => readonly HTMLElement[]
  focus?: () => void
  command?: DiffNavigationCommand
}): boolean {
  const geometry = bindings.get(args.editor)
  if (!geometry) {
    return false
  }
  geometry.item.owner.reveal(
    geometry.item,
    () => geometry.zonePoint(args.id, args.node, args.controls),
    args.focus,
    undefined,
    args.command
  )
  return true
}
