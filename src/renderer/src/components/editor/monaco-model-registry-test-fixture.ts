import { Uri } from 'monaco-editor'
import type { ClosedEditorTabMonacoRegistry } from './closed-editor-tab-disposal'

export type RecordingMonacoModelRegistry = ClosedEditorTabMonacoRegistry & {
  disposed: string[]
}

/**
 * A model registry backed by the real Monaco URI parser.
 *
 * Why real: the whole point of these tests is which paths `Uri.parse` accepts, so a fake parser
 * that echoes its input would assert nothing.
 */
export function createMonacoModelRegistryWithRealUri(
  modelPaths: readonly string[]
): RecordingMonacoModelRegistry {
  const disposed: string[] = []
  const modelsByUri = new Map<
    string,
    {
      dispose: () => void
      isAttachedToEditor: () => boolean
      uri: { toString: (skipEncoding?: boolean) => string }
    }
  >()

  for (const modelPath of modelPaths) {
    const key = Uri.parse(modelPath).toString()
    modelsByUri.set(key, {
      dispose: () => disposed.push(modelPath),
      isAttachedToEditor: () => false,
      uri: { toString: () => key }
    })
  }

  return {
    disposed,
    Uri,
    editor: {
      getModel: (uri: unknown) => modelsByUri.get(String(uri)) ?? null,
      getModels: () => [...modelsByUri.values()]
    }
  }
}
