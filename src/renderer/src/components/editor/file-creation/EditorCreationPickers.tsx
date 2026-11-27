import type { JSX } from 'react'
import { ModalBoundary } from '@/app-shell/root-surfaces/app-root-surface-boundaries'
import { MarkdownTemplatePicker } from '../markdown/documents/MarkdownTemplatePicker'
import { NewFileExtensionPicker } from './NewFileExtensionPicker'

export function EditorCreationPickers({ resetKey }: { resetKey: string | null }): JSX.Element {
  return (
    <>
      <ModalBoundary boundaryId="modal.markdown-template-picker" resetKey={resetKey}>
        <MarkdownTemplatePicker />
      </ModalBoundary>
      <ModalBoundary boundaryId="modal.new-file-extension-picker" resetKey={resetKey}>
        <NewFileExtensionPicker />
      </ModalBoundary>
    </>
  )
}
