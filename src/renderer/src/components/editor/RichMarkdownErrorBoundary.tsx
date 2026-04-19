import React from 'react'

type Props = {
  fileId: string
  children: React.ReactNode
}

type State = {
  error: Error | null
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
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[RichMarkdownEditor] render crash contained by boundary', error, info)
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.fileId !== this.props.fileId && this.state.error) {
      this.setState({ error: null })
    }
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <div>
            The rich markdown editor hit an unexpected error and was reset to keep the rest of Orca
            responsive.
          </div>
          <div className="text-xs opacity-70">
            Switch to source mode, or click retry to reload the rich view.
          </div>
          <button
            className="rounded border border-border/60 px-3 py-1 text-xs hover:bg-accent"
            onClick={this.handleReset}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
