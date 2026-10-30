import React from 'react'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { isLazyChunkLoadError } from '@/lib/lazy-with-retry'
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

// Module scope deduplicates breadcrumbs across file-keyed boundary remounts.
const recordedLazyChunkCauses = new Set<string>()

export function clearLazyChunkBreadcrumbDedupeForTest(): void {
  recordedLazyChunkCauses.clear()
}

function describeLazyChunkCause(error: Error): string {
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`
  }
  return cause === undefined ? 'unknown' : String(cause)
}

// Contain TipTap render and reload failures to this pane; fileId changes reset transient errors when switching tabs.
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
    if (isLazyChunkLoadError(error)) {
      const cause = describeLazyChunkCause(error)
      if (!recordedLazyChunkCauses.has(cause)) {
        recordedLazyChunkCauses.add(cause)
        recordRendererCrashBreadcrumb('lazy_chunk_boundary_degraded', {
          boundaryId: 'editor.rich-markdown',
          reloadKey: error.reloadKey,
          cause
        })
      }
      return
    }
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
            {translate(
              'auto.components.editor.RichMarkdownErrorBoundary.dfdf1cacd4',
              'The rich markdown editor hit an unexpected error and was reset to keep the rest of Orca responsive.'
            )}
          </div>
          <div className="text-xs opacity-70">
            {translate(
              'auto.components.editor.RichMarkdownErrorBoundary.4a5de9f2f0',
              'Switch to source mode, or click retry to reload the rich view.'
            )}
          </div>
          <button
            className="rounded border border-border/60 px-3 py-1 text-xs hover:bg-accent"
            onClick={this.handleReset}
          >
            {translate('auto.components.editor.RichMarkdownErrorBoundary.aad0998127', 'Retry')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
