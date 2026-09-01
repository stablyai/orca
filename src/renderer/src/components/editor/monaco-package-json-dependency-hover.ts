import type { OnMount } from '@monaco-editor/react'
import type { IDisposable } from 'monaco-editor'
import { useAppStore } from '@/store'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { resolvePackageJsonHoverContext } from './package-json-dependency-hover-context'
import { resolveInstalledPackageVersion } from './package-json-installed-version'
import { resolvePackageJsonDependencyHover } from './package-json-dependency-hover-resolution'

type MonacoApi = Parameters<OnMount>[1]

let provider: IDisposable | null = null
let providerMonaco: MonacoApi = null

/**
 * Registers the `package.json` dependency hover provider at most once per
 * Monaco instance. Monaco concatenates results from duplicate providers, so
 * without this guard every editor pane mount would stack another tooltip.
 * Mirrors `ensureMarkdownDocCompletionProvider` (monaco-markdown-doc-completions.ts).
 */
export function ensurePackageJsonDependencyHoverProvider(monaco: MonacoApi): void {
  if (provider && providerMonaco === monaco) {
    return
  }
  if (provider) {
    provider.dispose()
  }
  providerMonaco = monaco

  provider = monaco.languages.registerHoverProvider(
    { language: 'json', pattern: '**/package.json' },
    {
      async provideHover(model, position, token) {
        const result = await resolvePackageJsonDependencyHover({
          modelText: model.getValue(),
          offset: model.getOffsetAt(position),
          isCancelled: () => token.isCancellationRequested,
          resolveContext: () =>
            resolvePackageJsonHoverContext(
              useAppStore.getState(),
              model.uri.toString(),
              (filePath) => monaco.Uri.parse(filePath).toString()
            ),
          resolveInstalledVersion: (context, packageName) =>
            resolveInstalledPackageVersion({
              worktreeRoot: context.worktreeRoot,
              relativePath: context.relativePath,
              packageName,
              readCandidate: async (candidate) => {
                const fileContent = await readRuntimeFileContent({
                  settings: settingsForRuntimeOwner(
                    useAppStore.getState().settings,
                    context.runtimeEnvironmentId
                  ),
                  filePath: candidate.filePath,
                  relativePath: candidate.relativePath,
                  worktreeId: context.worktreeId,
                  connectionId: context.connectionId ?? undefined,
                  expectedExternalSshTargetId: context.externalSshTargetId
                })
                if (fileContent.isBinary) {
                  throw new Error('binary_file')
                }
                return fileContent.content
              }
            }),
          lookupPackageInfo: (request) => window.api.npmPackageInfo.lookup(request)
        })
        if (!result) {
          return undefined
        }
        return {
          contents: [{ value: result.markdown, isTrusted: false, supportHtml: false }],
          range: {
            startLineNumber: model.getPositionAt(result.startOffset).lineNumber,
            startColumn: model.getPositionAt(result.startOffset).column,
            endLineNumber: model.getPositionAt(result.endOffset).lineNumber,
            endColumn: model.getPositionAt(result.endOffset).column
          }
        }
      }
    }
  )
}
