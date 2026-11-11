import { useLayoutEffect, useRef } from 'react'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/editor/monaco/monaco-setup'
import { applyModelLanguage } from '@/lib/monaco-languages/plugin-syntax-editor-options'
import { useCombinedDiffRow } from './CombinedDiffViewport'
import { combinedDiffEditorPool, type RetainedDiffItem } from './combined-diff-editor-pool'
import { CombinedDiffNativeBinding } from './combined-diff-native-binding'
import { onCombinedEditorUnbind } from './combined-diff-editor-geometry'

export type CombinedDiffEditorMount = (
  editor: editor.IStandaloneDiffEditor,
  api: typeof monaco,
  identity: string
) => (() => void) | void

export function CombinedDiffEditor({
  original,
  modified,
  language,
  theme,
  options,
  onMount,
  index,
  className
}: {
  original: string
  modified: string
  language: string
  theme: string
  options: editor.IDiffEditorConstructionOptions
  onMount: CombinedDiffEditorMount
  index: number
  className?: string
}): React.JSX.Element {
  const item = useCombinedDiffRow()
  const ref = useRef<HTMLDivElement>(null)
  const bindingRef = useRef<CombinedDiffNativeBinding | null>(null)
  const recordRef = useRef<RetainedDiffItem | null>(null)
  const onMountRef = useRef(onMount)
  const initial = useRef({ original, modified, language, options })
  useLayoutEffect(() => {
    onMountRef.current = onMount
    initial.current = { original, modified, language, options }
  }, [onMount, original, modified, language, options])
  useLayoutEffect(() => {
    if (!item) {
      return
    }
    const body = ref.current!
    const pool = combinedDiffEditorPool(item.owner)
    const template = pool.acquire(initial.current.options)
    const record = pool.item(
      item,
      template,
      initial.current,
      initial.current.options,
      body.clientWidth
    )
    recordRef.current = record
    const binding = new CombinedDiffNativeBinding(
      item,
      template,
      record,
      initial.current.options,
      body,
      () => pool.release(template)
    )
    bindingRef.current = binding
    const detach = item.owner.bind(item, binding)
    const cleanup = onMountRef.current(template.editor, monaco, binding.identity)
    const unbind = onCombinedEditorUnbind(template.editor.getModifiedEditor(), () => {
      cleanup?.()
      if (bindingRef.current === binding) {
        bindingRef.current = null
        recordRef.current = null
      }
    })
    return () => {
      unbind()
      detach()
    }
  }, [item, index])
  useLayoutEffect(() => {
    bindingRef.current?.updateOptions(options)
  }, [options])
  useLayoutEffect(() => {
    const model = recordRef.current?.model
    applyModelLanguage([model?.original, model?.modified], language)
  }, [item, language])
  useLayoutEffect(() => {
    monaco.editor.setTheme(theme)
  }, [theme])
  return <div ref={ref} data-combined-diff-native="" className={className} />
}
