import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n/I18nProvider'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import MarkdownPreview from './MarkdownPreview'
import { RichMarkdownErrorBoundary } from './RichMarkdownErrorBoundary'
import { getMarkdownExportPayload, type MarkdownExportPayload } from './markdown-export-extract'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'
import { readRuntimeFileContent, type RuntimeFileReadArgs } from '@/runtime/runtime-file-client'

const sessions = new Map<string, LiveMarkdownPreviewWindow>()

class LiveMarkdownPreviewWindow {
  private container = document.createElement('div')
  private root: Root
  private observer: MutationObserver
  private timer: ReturnType<typeof setTimeout> | null = null
  private publishTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private content: string | null = null
  private refreshError: string | null = null
  private publishing = false
  private pendingPublish = false
  private revision = 0
  private offClosed: () => void

  constructor(
    private file: OpenFile,
    private payload: MarkdownExportPayload,
    private localFile?: RuntimeFileReadArgs
  ) {
    this.container.hidden = true
    this.container.inert = true
    document.body.append(this.container)
    this.root = createRoot(this.container)
    this.observer = new MutationObserver(() => this.schedulePublish())
    this.observer.observe(this.container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    })
    this.offClosed = window.api.docPreview.onMarkdownWindowClosed((fileId) => {
      if (fileId === this.file.id) {
        this.dispose()
      }
    })
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    try {
      const result = await window.api.docPreview.readMarkdownWindowSource(this.file.id)
      if (this.disposed) {
        return
      }
      if (!result.open) {
        this.dispose()
        return
      }
      if (this.localFile) {
        const disk = await readRuntimeFileContent(this.localFile)
        if (this.disposed) {
          return
        }
        if (disk.isBinary) {
          throw new Error('The file is no longer a Markdown document.')
        }
        result.content = disk.content
        result.error = null
      }
      const state = useAppStore.getState()
      const sourceId = this.file.markdownPreviewSourceFileId ?? this.file.id
      const sourceFile = state.openFiles.find((file) => file.id === sourceId)
      const draft = sourceFile?.isDirty ? state.editorDrafts[sourceId] : undefined
      const content = draft ?? result.content
      const error =
        content === null
          ? (result.error ?? 'Unable to refresh this document.')
          : exceedsMarkdownRichModeSizeLimit(content)
            ? 'The updated document is too large to refresh here. Open source view.'
            : null
      if (error) {
        if (error !== this.refreshError) {
          this.refreshError = error
          this.schedulePublish()
        }
      } else if (content !== null) {
        if (this.refreshError) {
          this.refreshError = null
          this.schedulePublish()
        }
        if (content !== this.content) {
          this.content = content
          this.revision += 1
          this.root.render(
            <I18nProvider>
              <TooltipProvider>
                <RichMarkdownErrorBoundary key={this.revision} fileId={this.file.id}>
                  <MarkdownPreview
                    content={content}
                    filePath={this.file.filePath}
                    sourceFileId={sourceId}
                    sourceWorktreeId={this.file.worktreeId}
                    sourceRuntimeEnvironmentId={this.file.runtimeEnvironmentId}
                    scrollCacheKey={`independent:${this.file.id}`}
                  />
                </RichMarkdownErrorBoundary>
              </TooltipProvider>
            </I18nProvider>
          )
        }
      }
    } catch (error) {
      if (!this.disposed) {
        this.refreshError =
          error instanceof Error ? error.message : 'Unable to refresh this document.'
        this.schedulePublish()
      }
    } finally {
      if (!this.disposed) {
        this.timer = setTimeout(() => void this.refresh(), 2000)
      }
    }
  }

  private schedulePublish(): void {
    if (this.disposed) {
      return
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer)
    }
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      void this.publish()
    }, 150)
  }

  private async publish(): Promise<void> {
    if (this.publishing) {
      this.pendingPublish = true
      return
    }
    this.publishing = true
    const revision = this.revision
    try {
      if (!this.refreshError) {
        const next = await getMarkdownExportPayload({
          root: this.container,
          title: this.payload.title,
          allowEmpty: true
        })
        if (!next || this.disposed || revision !== this.revision) {
          return
        }
        this.payload = next
      }
      if (this.disposed) {
        return
      }
      const open = await window.api.docPreview.updateMarkdownWindow({
        ...this.payload,
        fileId: this.file.id,
        refreshError: this.refreshError
      })
      if (!open) {
        this.dispose()
      }
    } catch (error) {
      console.warn('[markdown-window] Failed to refresh preview', error)
    } finally {
      this.publishing = false
      if (this.pendingPublish) {
        this.pendingPublish = false
        this.schedulePublish()
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer)
    }
    this.observer.disconnect()
    this.offClosed()
    this.root.unmount()
    this.container.remove()
    if (sessions.get(this.file.id) === this) {
      sessions.delete(this.file.id)
    }
  }
}

export function followMarkdownPreviewWindow(
  file: OpenFile,
  payload: MarkdownExportPayload,
  localFile?: RuntimeFileReadArgs
): () => void {
  sessions.get(file.id)?.dispose()
  const session = new LiveMarkdownPreviewWindow(file, payload, localFile)
  sessions.set(file.id, session)
  return () => session.dispose()
}
