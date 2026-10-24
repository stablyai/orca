import type React from 'react'
import type { ReactNode } from 'react'
import {
  buildFileEditorCenteredLayoutContentClassName,
  buildFileEditorCenteredLayoutShellClassName,
  isFileEditorCenteredLayoutEnabled
} from './file-editor-centered-layout'

export function EditorFileCenteredLayout({
  enabled,
  children
}: {
  enabled: boolean | undefined
  children: ReactNode
}): React.JSX.Element {
  const centered = isFileEditorCenteredLayoutEnabled(enabled)
  return (
    <div
      className={buildFileEditorCenteredLayoutShellClassName(enabled)}
      data-editor-centered-layout={centered ? 'true' : undefined}
    >
      <div className={buildFileEditorCenteredLayoutContentClassName(enabled)}>{children}</div>
    </div>
  )
}
