import React from 'react'
import { reportReactErrorBoundaryCrash } from '@/lib/react-error-boundary-reporting'
import { translate } from '@/i18n/i18n'

type Props = {
  fileId: string
  children: React.ReactNode
}

type State = {
  error: Error | null
  fileId: string
}

// Why: a thrown exception inside the TipTap/ProseMirror render or in the
// effect that runs `setContent` + `normalizeSoftBreaks` on external-reload
// would escape to the React root and — without this boundary — cause React
// 18 to unmount the entire renderer subtree, blacking out the whole Orca
// window (see issue #826). Scoping the boundary to the rich-markdown editor
// contains the failure to the affected pane so the rest of the workspace
// stays usable. Re-keying on `fileId` resets the boundary when the user
// switches tabs so a transient failure doesn't permanently disable the
// rich editor for that pane.
export class RichMarkdownErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, fileId: this.props.fileId }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.fileId !== state.fileId) {
      return { error: null, fileId: props.fileId }
    }

    return null
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[RichMarkdownEditor] render crash contained by boundary', error, info)
    void reportReactErrorBoundaryCrash({
      boundaryId: 'editor.rich-markdown',
      surface: 'rich-markdown-editor',
      error,
      errorInfo: info
    })
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <div>
            {translate("auto.components.editor.RichMarkdownErrorBoundary.dfdf1cacd4", "The rich markdown editor hit an unexpected error and was reset to keep the rest of Orca responsive.")}</div>
          <div className="text-xs opacity-70">
            {translate("auto.components.editor.RichMarkdownErrorBoundary.4a5de9f2f0", "Switch to source mode, or click retry to reload the rich view.")}</div>
          <button
            className="rounded border border-border/60 px-3 py-1 text-xs hover:bg-accent"
            onClick={this.handleReset}
          >
            {translate("auto.components.editor.RichMarkdownErrorBoundary.aad0998127", "Retry")}</button>
        </div>
      )
    }
    return this.props.children
  }
}
