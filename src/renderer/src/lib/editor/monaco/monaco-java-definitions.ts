import type * as Monaco from 'monaco-editor'
import { useAppStore } from '@/store/index'
import { findJavaNavigationRequest } from '../import-navigation/java/java-navigation-request'
import { outlineJavaSource } from '../import-navigation/java/java-source-outline'
import { resolveJavaNavigationTarget } from '../import-navigation/java/java-target-resolution'
import {
  createOpenFileImportNavigationAccess,
  importNavigationRootOf
} from '../import-navigation/open-file-import-navigation-access'
import { importNavigationSourceFile, importNavigationTargetLink } from './monaco-import-definitions'

type MonacoNamespace = typeof Monaco

async function javaDefinition(
  monaco: MonacoNamespace,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  token: Monaco.CancellationToken
): Promise<Monaco.languages.LocationLink[] | null> {
  const file = importNavigationSourceFile(model)
  const rootPath = file ? importNavigationRootOf(file) : null
  if (!file || !rootPath) {
    return null
  }
  const content = model.getValue()
  const outline = outlineJavaSource(content)
  const request = findJavaNavigationRequest(content, outline, model.getOffsetAt(position))
  const access = request ? createOpenFileImportNavigationAccess(useAppStore.getState(), file) : null
  if (!request || !access) {
    return null
  }
  const resolved = await resolveJavaNavigationTarget(
    access,
    { filePath: file.filePath, rootPath, content, outline },
    request
  )
  if (!resolved || token.isCancellationRequested || model.isDisposed()) {
    return null
  }
  if (resolved.filePath === file.filePath) {
    const start = model.getPositionAt(resolved.offset)
    const word = model.getWordAtPosition(start)
    return [
      {
        uri: model.uri,
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: start.lineNumber,
          endColumn: word?.endColumn ?? start.column
        }
      }
    ]
  }
  const link = importNavigationTargetLink(monaco, file, rootPath, resolved)
  return link ? [link] : null
}

/**
 * Go to Definition (Cmd/Ctrl+Click, F12) for Java without a language server: types through
 * imports, the package and source roots, members through the file and its supertypes.
 */
export function installMonacoJavaDefinitions(monaco: MonacoNamespace): void {
  monaco.languages.registerDefinitionProvider('java', {
    async provideDefinition(model, position, token) {
      return (await javaDefinition(monaco, model, position, token).catch(() => null)) ?? []
    }
  })
}
