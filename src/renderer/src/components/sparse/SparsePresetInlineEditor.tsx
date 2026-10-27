import { useCallback, useEffect, useId, useRef } from 'react'
import type { ComponentProps } from 'react'
import { translate } from '@/i18n/i18n'
import { SparseCheckoutPresetDraftForm } from './SparseCheckoutPresetDraftForm'

export function SparsePresetInlineEditor(
  props: ComponentProps<typeof SparseCheckoutPresetDraftForm>
): React.JSX.Element {
  const titleId = useId()
  const editorRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' })
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const focusName = useCallback((node: HTMLInputElement | null) => {
    node?.focus()
    node?.closest('[data-sparse-preset-editor]')?.scrollIntoView({ block: 'start' })
  }, [])
  return (
    <section
      role="region"
      ref={editorRef}
      data-sparse-preset-editor="true"
      aria-labelledby={titleId}
      className="space-y-3 border-t border-border pt-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (!props.submitting) {
            props.onCancel()
          }
        }
      }}
    >
      <h4 id={titleId} className="text-sm font-medium">
        {props.draft.mode === 'new'
          ? translate('sparsePreset.new', 'New sparse preset')
          : translate('sparsePreset.edit', 'Edit sparse preset')}
      </h4>
      <SparseCheckoutPresetDraftForm
        {...props}
        setNameInputNode={props.setNameInputNode ?? focusName}
      />
    </section>
  )
}
