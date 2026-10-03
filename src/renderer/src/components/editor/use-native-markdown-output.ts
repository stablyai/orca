import { useContext, useEffect, useMemo, useState } from 'react'
import { NativeMarkdownRenderContext } from './native-markdown-render-context'
import { useNativeMarkdownProviderCatalog } from './native-markdown-provider-catalog'
import { PLUGIN_MARKDOWN_CODE_MAX_LENGTH } from '../../../../shared/plugins/plugin-markdown-renderer'
import {
  startNativeMarkdownRenderSession,
  type NativeMarkdownRenderResult
} from './native-markdown-render-session'

export function useNativeMarkdownOutput(language: string, code: string) {
  const context = useContext(NativeMarkdownRenderContext)
  const catalog = useNativeMarkdownProviderCatalog(language)
  const [result, setResult] = useState<NativeMarkdownRenderResult | null>(null)
  const source = context?.source
  const supported =
    context?.canRender !== false &&
    catalog.languages.includes(language) &&
    code.length <= PLUGIN_MARKDOWN_CODE_MAX_LENGTH &&
    Boolean(source?.sourceFileId && source.sourceWorktreeId)
  const key = JSON.stringify([
    language,
    supported ? code : null,
    source,
    context?.ownershipKey,
    catalog.revision
  ])

  useEffect(() => {
    if (!supported || !source?.sourceFileId || !source.sourceWorktreeId) {
      return
    }
    const fileId = source.sourceFileId
    const worktreeId = source.sourceWorktreeId
    const plugins = window.api?.plugins
    if (!plugins?.resolveMarkdownSource || !plugins.renderMarkdown) {
      return
    }
    return startNativeMarkdownRenderSession(
      plugins,
      {
        fileId,
        worktreeId,
        filePath: source.filePath,
        runtimeEnvironmentId: source.sourceRuntimeEnvironmentId,
        language,
        code,
        key
      },
      setResult
    )
  }, [code, key, language, source, supported])

  const outputContext = useMemo(
    () =>
      context && result
        ? {
            ...context,
            openReference: (reference: Parameters<typeof context.openReference>[0]) =>
              context.openReference(reference, result.source)
          }
        : context,
    [context, result]
  )
  return { context: outputContext, output: supported && result?.key === key ? result.output : null }
}
