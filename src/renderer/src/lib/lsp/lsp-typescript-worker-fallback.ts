import type * as Monaco from 'monaco-editor'
import type { MonacoRangeLike } from './lsp-conversions'

type TsWorker = Pick<
  Monaco.typescript.TypeScriptWorker,
  'getQuickInfoAtPosition' | 'getDefinitionAtPosition' | 'getReferencesAtPosition'
>
type GetWorker = () => Promise<(...uris: Monaco.Uri[]) => Promise<TsWorker>>
type FallbackModel = Pick<
  Monaco.editor.ITextModel,
  'uri' | 'getLanguageId' | 'getOffsetAt' | 'getPositionAt' | 'isDisposed'
>
export type WorkerFallbackMonaco = {
  typescript: { getTypeScriptWorker: GetWorker; getJavaScriptWorker: GetWorker }
  editor: { getModel(uri: Monaco.Uri): FallbackModel | null }
  Uri: { parse(value: string): Monaco.Uri }
}
type Position = { lineNumber: number; column: number }
type TextSpan = { start: number; length: number }
type Location = { uri: Monaco.Uri; range: MonacoRangeLike }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTextSpan(value: unknown): value is TextSpan {
  return isRecord(value) && typeof value.start === 'number' && typeof value.length === 'number'
}

function partsToString(parts: unknown): string {
  return Array.isArray(parts)
    ? parts
        .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
        .join('')
    : ''
}

function tagsToString(tags: unknown): string {
  if (!Array.isArray(tags)) {
    return ''
  }
  return tags
    .filter(isRecord)
    .map((tag) => {
      const text = typeof tag.text === 'string' ? tag.text : partsToString(tag.text)
      return text ? `*@${String(tag.name)}* \u2014 ${text}` : `*@${String(tag.name)}*`
    })
    .join('  \n\n')
}

function spanToRange(model: FallbackModel, span: TextSpan): MonacoRangeLike {
  const start = model.getPositionAt(span.start)
  const end = model.getPositionAt(span.start + span.length)
  return {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column
  }
}

/** Monaco's own TS/JS worker navigation, for models no language server owns. */
export function createTypeScriptWorkerFallback(monaco: WorkerFallbackMonaco) {
  const withWorker = async <T>(
    model: FallbackModel,
    run: (worker: TsWorker, fileName: string) => Promise<T>
  ): Promise<T | null> => {
    const languageId = model.getLanguageId()
    const getWorker =
      languageId === 'typescript'
        ? monaco.typescript.getTypeScriptWorker
        : languageId === 'javascript'
          ? monaco.typescript.getJavaScriptWorker
          : null
    if (!getWorker) {
      return null
    }
    try {
      const worker = await (await getWorker())(model.uri)
      return model.isDisposed() ? null : await run(worker, model.uri.toString())
    } catch {
      return null
    }
  }

  const locations = (entries: unknown): Location[] => {
    const result: Location[] = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isRecord(entry) || typeof entry.fileName !== 'string' || !isTextSpan(entry.textSpan)) {
        continue
      }
      // Why: like Monaco's adapter, only files that already have a model can be shown.
      const target = monaco.editor.getModel(monaco.Uri.parse(entry.fileName))
      if (target) {
        result.push({ uri: target.uri, range: spanToRange(target, entry.textSpan) })
      }
    }
    return result
  }

  return {
    hover: (model: FallbackModel, position: Position) =>
      withWorker(model, async (worker, fileName) => {
        const info: unknown = await worker.getQuickInfoAtPosition(
          fileName,
          model.getOffsetAt(position)
        )
        if (!isRecord(info) || model.isDisposed()) {
          return null
        }
        return {
          range: isTextSpan(info.textSpan) ? spanToRange(model, info.textSpan) : undefined,
          contents: [
            { value: `\`\`\`typescript\n${partsToString(info.displayParts)}\n\`\`\`\n` },
            {
              value: [partsToString(info.documentation), tagsToString(info.tags)]
                .filter(Boolean)
                .join('\n\n')
            }
          ]
        }
      }),
    definition: (model: FallbackModel, position: Position) =>
      withWorker(model, async (worker, fileName) =>
        locations(await worker.getDefinitionAtPosition(fileName, model.getOffsetAt(position)))
      ),
    references: (model: FallbackModel, position: Position) =>
      withWorker(model, async (worker, fileName) =>
        locations(await worker.getReferencesAtPosition(fileName, model.getOffsetAt(position)))
      )
  }
}
