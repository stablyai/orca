import { createBrowserUuid } from '@/lib/browser-uuid'
import type { PluginsApi } from '../../../../preload/api/plugin-host-api'
import {
  pluginMarkdownWorkerResultSchema,
  pluginMarkdownSourceSchema,
  pluginMarkdownOutputSchema,
  PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES,
  type PluginMarkdownOutput,
  type PluginMarkdownSource
} from '../../../../shared/plugins/plugin-markdown-renderer'

export type NativeMarkdownRenderResult = {
  key: string
  output: PluginMarkdownOutput
  source: PluginMarkdownSource
}

export function startNativeMarkdownRenderSession(
  plugins: PluginsApi,
  request: {
    fileId: string
    worktreeId: string
    filePath: string
    runtimeEnvironmentId: string | null | undefined
    language: string
    code: string
    key: string
  },
  setResult: (result: NativeMarkdownRenderResult | null) => void
): () => void {
  const { fileId, worktreeId, language, code, key } = request
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let revision: string | undefined
  let sourceSignature: string | undefined
  const sessionId = createBrowserUuid()
  const run = async (): Promise<void> => {
    try {
      const resolved = await plugins.resolveMarkdownSource({
        fileId,
        documentPath: request.filePath,
        worktreeId,
        runtimeEnvironmentId: request.runtimeEnvironmentId ?? null
      })
      if (!active) {
        return
      }
      if (resolved.status !== 'resolved') {
        setResult(null)
        return
      }
      const parsedSource = pluginMarkdownSourceSchema.safeParse(resolved.source)
      if (
        !parsedSource.success ||
        parsedSource.data.fileId !== fileId ||
        parsedSource.data.worktreeId !== worktreeId
      ) {
        setResult(null)
        return
      }
      const nextSourceSignature = JSON.stringify(parsedSource.data)
      if (sourceSignature !== nextSourceSignature) {
        sourceSignature = nextSourceSignature
        revision = undefined
        setResult(null)
      }
      const response = await plugins.renderMarkdown({
        language,
        code,
        source: parsedSource.data,
        sessionId,
        knownRevision: revision
      })
      if (!active) {
        return
      }
      if (response.status !== 'rendered') {
        const error = pluginMarkdownOutputSchema.safeParse({
          kind: 'error',
          message: response.status === 'error' ? response.message : undefined
        })
        setResult(
          response.status === 'error' && response.code === 'provider-error' && error.success
            ? { key, output: error.data, source: parsedSource.data }
            : null
        )
        return
      }
      const parsed = pluginMarkdownWorkerResultSchema.safeParse({
        sessionId: response.sessionId,
        revision: response.revision,
        output: response.output
      })
      if (
        !parsed.success ||
        parsed.data.sessionId !== sessionId ||
        new TextEncoder().encode(JSON.stringify(parsed.data.output)).byteLength >
          PLUGIN_MARKDOWN_OUTPUT_MAX_BYTES
      ) {
        setResult(null)
        return
      }
      revision = parsed.data.revision
      setResult({ key, output: parsed.data.output, source: parsedSource.data })
    } catch {
      if (active) {
        setResult(null)
      }
    } finally {
      if (active) {
        timer = setTimeout(() => void run(), 2500)
      }
    }
  }
  void run()
  return () => {
    active = false
    clearTimeout(timer)
    void plugins.cancelMarkdownRender?.({ sessionId }).catch(() => {})
  }
}
