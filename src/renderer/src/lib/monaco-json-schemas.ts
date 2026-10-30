import type * as Monaco from 'monaco-editor'
import { useAppStore } from '@/store'
import { createJsonSchemaCache, fetchJsonSchema } from './json-schema-cache'
import { readJsonSchemaFile } from './json-schema-file-reader'

const CATALOG_URI = 'https://www.schemastore.org/api/json/catalog.json'
function downloadsEnabled(
  settings: { editorRemoteJsonSchemas?: boolean } | null | undefined
): boolean {
  return settings != null && settings.editorRemoteJsonSchemas !== false
}
const remoteEnabled = (): boolean => downloadsEnabled(useAppStore.getState().settings)
const schemaCache = createJsonSchemaCache(
  (uri, signal) => (/^https?:/i.test(uri) ? fetchJsonSchema(uri, signal) : readJsonSchemaFile(uri)),
  remoteEnabled
)

export function connectJsonSchemaWorker(worker: Worker): Worker {
  worker.addEventListener('message', (event: MessageEvent) => {
    if (event.data?.orcaJsonSchema !== 'request') {
      return
    }
    event.stopImmediatePropagation()
    const { id, uri } = event.data
    if (typeof id !== 'number' || typeof uri !== 'string') {
      return
    }
    void schemaCache.read(uri).then(
      (content) => worker.postMessage({ orcaJsonSchema: 'response', id, content }),
      (error: unknown) =>
        worker.postMessage({
          orcaJsonSchema: 'response',
          id,
          error: error instanceof Error ? error.message : 'Unable to load JSON schema'
        })
    )
  })
  return worker
}

type Catalog = { schemas: { url: string; fileMatch?: string[] }[] }

export function parseJsonSchemaCatalog(text: string): Catalog {
  const parsed: unknown = JSON.parse(text)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('schemas' in parsed) ||
    !Array.isArray(parsed.schemas)
  ) {
    throw new Error('Invalid JSON schema catalog')
  }
  const schemas: Catalog['schemas'] = []
  for (const entry of parsed.schemas) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.url !== 'string' ||
      !/^https?:\/\//i.test(entry.url)
    ) {
      continue
    }
    if (
      !Array.isArray(entry.fileMatch) ||
      !entry.fileMatch.every((name: unknown) => typeof name === 'string')
    ) {
      continue
    }
    schemas.push({ url: entry.url, fileMatch: entry.fileMatch })
  }
  return { schemas }
}

export function installMonacoJsonSchemas(monaco: typeof Monaco): () => void {
  let catalog: Catalog | undefined
  let catalogRequest: Promise<void> | undefined
  let disposed = false
  let lastConfiguration = ''
  const configure = (): void => {
    if (disposed) {
      return
    }
    const models = monaco.editor.getModels().filter((model) => model.getLanguageId() === 'json')
    const schemas: { uri: string; fileMatch: string[] }[] = []
    if (remoteEnabled() && catalog) {
      for (const model of models) {
        const name = model.uri.path.split('/').pop() ?? ''
        for (const schema of catalog.schemas) {
          // Only exact filenames: catalog globs are not safe to turn into JavaScript regexes.
          if (schema.fileMatch?.includes(name)) {
            schemas.push({ uri: schema.url, fileMatch: [model.uri.toString()] })
            break
          }
        }
      }
    }
    const options: Monaco.json.DiagnosticsOptions = {
      validate: true,
      allowComments: true,
      trailingCommas: 'ignore',
      enableSchemaRequest: true,
      schemaValidation: 'error',
      schemas
    }
    const configuration = JSON.stringify([remoteEnabled(), options])
    if (configuration !== lastConfiguration) {
      lastConfiguration = configuration
      monaco.json.jsonDefaults.setDiagnosticsOptions(options)
    }
    if (models.length && remoteEnabled() && !catalog && !catalogRequest) {
      catalogRequest = schemaCache
        .read(CATALOG_URI)
        .then((text) => {
          catalog = parseJsonSchemaCatalog(text)
          configure()
        })
        .catch(() => {
          catalogRequest = undefined
          // Explicit $schema still works when the optional filename catalog is unavailable.
        })
    }
  }
  const created = monaco.editor.onDidCreateModel(configure)
  const changedLanguage = monaco.editor.onDidChangeModelLanguage(configure)
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (downloadsEnabled(state.settings) === downloadsEnabled(previous.settings)) {
      return
    }
    schemaCache.clear()
    configure()
  })
  configure()
  return () => {
    disposed = true
    created.dispose()
    changedLanguage.dispose()
    unsubscribe()
    schemaCache.clear()
  }
}
