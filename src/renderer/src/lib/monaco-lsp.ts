/* eslint-disable max-lines -- Why: Monaco's LSP adapter needs shared context for
providers, diagnostics, document sync, and cleanup; keeping it together prevents
provider/document lifecycle drift. */
import type * as monacoTypes from 'monaco-editor'
import type {
  LspCompletionItem,
  LspCompletionResult,
  LspDiagnosticsEvent,
  LspDocumentContext,
  LspHover,
  LspLocation,
  LspPosition,
  LspRange,
  LspServerStatus
} from '../../../shared/lsp-types'

type Monaco = typeof monacoTypes

type LspModelContext = LspDocumentContext & {
  modelUri: string
  opened: boolean
  status: LspServerStatus | null
  lastSyncedContent: string
  changeTimer: ReturnType<typeof setTimeout> | null
  changePromise: Promise<void> | null
  openPromise: Promise<void> | null
  nextOpenRetryAt: number
}

type LspModelEntry = {
  context: LspModelContext
  references: number
  disposed: boolean
}

const LSP_MARKER_OWNER = 'orca-lsp'
const CHANGE_DEBOUNCE_MS = 250
const OPEN_RETRY_DELAY_MS = 2_000
// Why: Monaco already wires its TypeScript worker for JS/TS. Registering a
// second external provider there duplicates completions and definitions.
const SUPPORTED_LSP_LANGUAGES = ['rust', 'c', 'cpp', 'go', 'python']

const entriesByModelUri = new Map<string, LspModelEntry>()
let providersRegistered = false
let diagnosticsRegistered = false
const rendererLspInstanceId = Math.random().toString(36).slice(2)
let nextLspDocumentId = 1

function hasLspApi(): boolean {
  return typeof window !== 'undefined' && Boolean(window.api?.lsp)
}

function createDocumentId(modelUri: string): string {
  return `${rendererLspInstanceId}:${nextLspDocumentId++}:${modelUri}`
}

function lspPosition(position: monacoTypes.Position): LspPosition {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1
  }
}

function monacoRange(monaco: Monaco, range: LspRange): monacoTypes.Range {
  return new monaco.Range(
    range.start.line + 1,
    range.start.character + 1,
    range.end.line + 1,
    range.end.character + 1
  )
}

function markerSeverity(monaco: Monaco, severity: number | undefined): monacoTypes.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error
    case 2:
      return monaco.MarkerSeverity.Warning
    case 3:
      return monaco.MarkerSeverity.Info
    case 4:
      return monaco.MarkerSeverity.Hint
    default:
      return monaco.MarkerSeverity.Warning
  }
}

function completionKind(
  monaco: Monaco,
  kind: number | undefined
): monacoTypes.languages.CompletionItemKind {
  const k = monaco.languages.CompletionItemKind
  switch (kind) {
    case 2:
      return k.Method
    case 3:
      return k.Function
    case 4:
      return k.Constructor
    case 5:
      return k.Field
    case 6:
      return k.Variable
    case 7:
      return k.Class
    case 8:
      return k.Interface
    case 9:
      return k.Module
    case 10:
      return k.Property
    case 11:
      return k.Unit
    case 12:
      return k.Value
    case 13:
      return k.Enum
    case 14:
      return k.Keyword
    case 15:
      return k.Snippet
    case 16:
      return k.Color
    case 17:
      return k.File
    case 18:
      return k.Reference
    case 19:
      return k.Folder
    case 20:
      return k.EnumMember
    case 21:
      return k.Constant
    case 22:
      return k.Struct
    case 23:
      return k.Event
    case 24:
      return k.Operator
    case 25:
      return k.TypeParameter
    default:
      return k.Text
  }
}

function documentationToMarkdown(
  documentation: LspCompletionItem['documentation'] | undefined
): string | undefined {
  if (!documentation) {
    return undefined
  }
  if (typeof documentation === 'string') {
    return documentation
  }
  return documentation.value
}

function hoverContents(hover: LspHover | null): monacoTypes.IMarkdownString[] {
  if (!hover) {
    return []
  }
  const raw = Array.isArray(hover.contents) ? hover.contents : [hover.contents]
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') {
      return entry ? [{ value: entry }] : []
    }
    if ('language' in entry) {
      return [{ value: `\`\`\`${entry.language}\n${entry.value}\n\`\`\`` }]
    }
    return entry.value ? [{ value: entry.value }] : []
  })
}

function completionItems(result: LspCompletionResult | null): LspCompletionItem[] {
  if (!result) {
    return []
  }
  return Array.isArray(result) ? result : result.items
}

function findContext(model: monacoTypes.editor.ITextModel): LspModelContext | undefined {
  return entriesByModelUri.get(model.uri.toString())?.context
}

function contexts(): Iterable<LspModelContext> {
  return Array.from(entriesByModelUri.values(), (entry) => entry.context)
}

function documentPayload(context: LspModelContext, content = context.content): LspDocumentContext {
  return {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    filePath: context.filePath,
    languageId: context.languageId,
    content,
    connectionId: context.connectionId,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    documentId: context.documentId
  }
}

function documentIdentityPayload(context: LspModelContext): Omit<LspDocumentContext, 'content'> {
  return {
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    filePath: context.filePath,
    languageId: context.languageId,
    connectionId: context.connectionId,
    runtimeEnvironmentId: context.runtimeEnvironmentId,
    documentId: context.documentId
  }
}

async function openContext(context: LspModelContext): Promise<void> {
  if (!hasLspApi()) {
    return
  }
  try {
    const status = await window.api.lsp.getStatus(documentIdentityPayload(context))
    context.status = status
    if (status.state !== 'available') {
      context.opened = false
      context.nextOpenRetryAt = Date.now() + OPEN_RETRY_DELAY_MS
      return
    }
    const openedContent = context.content
    await window.api.lsp.openDocument(documentPayload(context, openedContent))
    context.opened = true
    context.nextOpenRetryAt = 0
    context.lastSyncedContent = openedContent
    if (context.content !== openedContent) {
      await queueDocumentChange(context, context.content)
    }
  } catch {
    context.opened = false
    context.nextOpenRetryAt = Date.now() + OPEN_RETRY_DELAY_MS
    throw new Error('LSP document open failed')
  }
}

async function ensureContextOpen(context: LspModelContext): Promise<boolean> {
  await context.openPromise
  if (context.status?.state === 'available' && context.opened) {
    return true
  }
  if (Date.now() < context.nextOpenRetryAt) {
    return false
  }
  // Why: SSH reconnects and late server installs can turn an unavailable LSP
  // into an available one while the editor stays mounted. Retry on demand with
  // a short cooldown instead of making availability sticky for the tab lifetime.
  context.openPromise = openContext(context).catch(() => undefined)
  await context.openPromise
  return context.status?.state === 'available' && context.opened
}

async function ensureLatestContent(context: LspModelContext): Promise<boolean> {
  if (!hasLspApi()) {
    return false
  }
  if (!(await ensureContextOpen(context))) {
    return false
  }
  // Why: Monaco already gives us full-document content through onChange.
  // Reading the model again on completion/hover would copy large files on the
  // interactive request path even when no edit is pending.
  const content = context.content
  if (content !== context.lastSyncedContent) {
    if (context.changeTimer) {
      clearTimeout(context.changeTimer)
      context.changeTimer = null
    }
    await queueDocumentChange(context, content)
  } else if (context.changePromise) {
    await context.changePromise
  }
  return true
}

function scheduleChange(context: LspModelContext, content: string): void {
  context.content = content
  if (!context.opened || context.status?.state !== 'available' || !hasLspApi()) {
    return
  }
  if (context.changeTimer) {
    clearTimeout(context.changeTimer)
  }
  context.changeTimer = setTimeout(() => {
    context.changeTimer = null
    void queueDocumentChange(context, content).catch(() => {})
  }, CHANGE_DEBOUNCE_MS)
}

function markContextUnavailable(context: LspModelContext): void {
  context.opened = false
  context.status = null
  context.nextOpenRetryAt = Date.now() + OPEN_RETRY_DELAY_MS
}

function registerDiagnostics(monaco: Monaco): void {
  if (diagnosticsRegistered || !hasLspApi()) {
    return
  }
  diagnosticsRegistered = true
  window.api.lsp.onDiagnostics((event: LspDiagnosticsEvent) => {
    for (const context of contexts()) {
      if (
        context.filePath !== event.filePath ||
        context.worktreePath !== event.worktreePath ||
        context.languageId !== event.languageId ||
        (context.connectionId ?? undefined) !== (event.connectionId ?? undefined) ||
        (context.runtimeEnvironmentId ?? undefined) !== (event.runtimeEnvironmentId ?? undefined)
      ) {
        continue
      }
      const model = monaco.editor.getModel(monaco.Uri.parse(context.modelUri))
      if (!model) {
        continue
      }
      monaco.editor.setModelMarkers(
        model,
        LSP_MARKER_OWNER,
        event.diagnostics.map((diagnostic) => ({
          severity: markerSeverity(monaco, diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.source ?? 'LSP',
          code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
          startLineNumber: diagnostic.range.start.line + 1,
          startColumn: diagnostic.range.start.character + 1,
          endLineNumber: diagnostic.range.end.line + 1,
          endColumn: diagnostic.range.end.character + 1
        }))
      )
    }
  })
}

function sameDocumentIdentity(context: LspModelContext, args: LspDocumentContext): boolean {
  return (
    context.worktreePath === args.worktreePath &&
    context.filePath === args.filePath &&
    context.languageId === args.languageId &&
    (context.connectionId ?? undefined) === (args.connectionId ?? undefined) &&
    (context.runtimeEnvironmentId ?? undefined) === (args.runtimeEnvironmentId ?? undefined) &&
    (!args.documentId || !context.documentId || context.documentId === args.documentId)
  )
}

function completionInsertText(item: LspCompletionItem): string {
  return item.textEdit?.newText ?? item.insertText ?? item.label
}

function completionRange(
  monaco: Monaco,
  item: LspCompletionItem,
  fallbackRange: monacoTypes.Range
): monacoTypes.languages.CompletionItem['range'] {
  const textEdit = item.textEdit
  if (!textEdit) {
    return fallbackRange
  }
  if ('insert' in textEdit) {
    return {
      insert: monacoRange(monaco, textEdit.insert),
      replace: monacoRange(monaco, textEdit.replace)
    }
  }
  return monacoRange(monaco, textEdit.range)
}

function additionalTextEdits(
  monaco: Monaco,
  item: LspCompletionItem
): monacoTypes.languages.TextEdit[] | undefined {
  return item.additionalTextEdits?.map((edit) => ({
    range: monacoRange(monaco, edit.range),
    text: edit.newText
  }))
}

function monacoLocation(monaco: Monaco, location: LspLocation): monacoTypes.languages.Location {
  return {
    uri: monaco.Uri.parse(location.uri),
    range: monacoRange(monaco, location.range)
  }
}

function queueDocumentChange(context: LspModelContext, content: string): Promise<void> {
  const previous = context.changePromise?.catch(() => undefined) ?? Promise.resolve()
  const run = previous.then(async () => {
    if (!context.opened || context.status?.state !== 'available' || !hasLspApi()) {
      return
    }
    await window.api.lsp.changeDocument(documentPayload(context, content))
    if (context.content === content) {
      context.lastSyncedContent = content
    }
  })
  const queued = run.catch(() => undefined)
  context.changePromise = queued
  void queued.finally(() => {
    if (context.changePromise === queued) {
      context.changePromise = null
    }
  })
  return run
}

function startOpening(entry: LspModelEntry): void {
  const context = entry.context
  context.openPromise = openContext(context).catch(() => undefined)
}

function releaseEntry(monaco: Monaco, modelUri: string, entry: LspModelEntry): void {
  if (entry.references <= 0) {
    return
  }
  entry.references--
  if (entry.references > 0) {
    return
  }

  entry.disposed = true
  const isCurrentEntry = entriesByModelUri.get(modelUri) === entry
  if (isCurrentEntry) {
    entriesByModelUri.delete(modelUri)
  }
  if (entry.context.changeTimer) {
    clearTimeout(entry.context.changeTimer)
    entry.context.changeTimer = null
  }
  const pendingChange = entry.context.changePromise
  if (isCurrentEntry) {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelUri))
    if (model) {
      monaco.editor.setModelMarkers(model, LSP_MARKER_OWNER, [])
    }
  }
  void entry.context.openPromise
    ?.then(async () => {
      await pendingChange?.catch(() => undefined)
      const currentEntry = entriesByModelUri.get(modelUri)
      if (currentEntry && sameDocumentIdentity(currentEntry.context, entry.context)) {
        return
      }
      if (entry.context.opened && hasLspApi()) {
        await window.api.lsp.closeDocument(documentIdentityPayload(entry.context))
      }
    })
    .catch(() => {})
}

export function ensureMonacoLspProviders(monaco: Monaco): void {
  registerDiagnostics(monaco)
  if (providersRegistered) {
    return
  }
  providersRegistered = true

  for (const language of SUPPORTED_LSP_LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', ':', '"', "'", '/', '<'],
      provideCompletionItems: async (model, position) => {
        const context = findContext(model)
        try {
          if (!context || !(await ensureLatestContent(context))) {
            return { suggestions: [] }
          }
          const result = await window.api.lsp.completion({
            ...documentIdentityPayload(context),
            position: lspPosition(position)
          })
          const range = model.getWordUntilPosition(position)
          const replaceRange = new monaco.Range(
            position.lineNumber,
            range.startColumn,
            position.lineNumber,
            range.endColumn
          )
          return {
            suggestions: completionItems(result).map((item) => ({
              label: item.label,
              kind: completionKind(monaco, item.kind),
              detail: item.detail,
              documentation: documentationToMarkdown(item.documentation),
              insertText: completionInsertText(item),
              insertTextRules:
                item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                  : undefined,
              sortText: item.sortText,
              filterText: item.filterText,
              range: completionRange(monaco, item, replaceRange),
              additionalTextEdits: additionalTextEdits(monaco, item)
            }))
          }
        } catch {
          if (context) {
            markContextUnavailable(context)
          }
          return { suggestions: [] }
        }
      }
    })

    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const context = findContext(model)
        try {
          if (!context || !(await ensureLatestContent(context))) {
            return null
          }
          const hover = await window.api.lsp.hover({
            ...documentIdentityPayload(context),
            position: lspPosition(position)
          })
          const contents = hoverContents(hover)
          return contents.length === 0
            ? null
            : {
                contents,
                range: hover?.range ? monacoRange(monaco, hover.range) : undefined
              }
        } catch {
          if (context) {
            markContextUnavailable(context)
          }
          return null
        }
      }
    })

    monaco.languages.registerDefinitionProvider(language, {
      provideDefinition: async (model, position) => {
        const context = findContext(model)
        try {
          if (!context || !(await ensureLatestContent(context))) {
            return []
          }
          const definitions = await window.api.lsp.definition({
            ...documentIdentityPayload(context),
            position: lspPosition(position)
          })
          return definitions.map((location) => monacoLocation(monaco, location))
        } catch {
          if (context) {
            markContextUnavailable(context)
          }
          return []
        }
      }
    })
  }
}

export function registerMonacoLspDocument(
  monaco: Monaco,
  args: LspDocumentContext & { modelUri: string }
): () => void {
  if (!SUPPORTED_LSP_LANGUAGES.includes(args.languageId)) {
    return () => {}
  }
  ensureMonacoLspProviders(monaco)
  const existing = entriesByModelUri.get(args.modelUri)
  if (existing && sameDocumentIdentity(existing.context, args)) {
    existing.references++
    existing.context.content = args.content
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseEntry(monaco, args.modelUri, existing)
    }
  }
  if (existing) {
    // Why: Monaco providers are keyed only by model URI. If the same URI is
    // reused for a different backend identity, keeping both contexts would make
    // request routing ambiguous; replace the stale owner before opening a new one.
    while (existing.references > 0) {
      releaseEntry(monaco, args.modelUri, existing)
    }
  }

  const context: LspModelContext = {
    ...args,
    opened: false,
    status: null,
    lastSyncedContent: args.content,
    changeTimer: null,
    changePromise: null,
    openPromise: null,
    nextOpenRetryAt: 0,
    documentId: args.documentId ?? createDocumentId(args.modelUri)
  }
  const entry: LspModelEntry = {
    context,
    references: 1,
    disposed: false
  }
  entriesByModelUri.set(args.modelUri, entry)
  startOpening(entry)

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    releaseEntry(monaco, args.modelUri, entry)
  }
}

export function updateMonacoLspDocumentContent(modelUri: string, content: string): void {
  const entry = entriesByModelUri.get(modelUri)
  if (!entry) {
    return
  }
  scheduleChange(entry.context, content)
}
