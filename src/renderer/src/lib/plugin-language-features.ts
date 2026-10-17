import type * as Monaco from 'monaco-editor'
import { typescript as monacoTS } from 'monaco-editor'
import { useAppStore } from '@/store'
import {
  collectActivePluginLanguageFeatures,
  ensurePluginPanelsLoaded,
  usePluginPanelsStore,
  type ActivePluginLanguageFeature
} from '@/store/plugin-panels'
import type { OpenFile } from '@/store/slices/editor'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { detectLanguage } from './language-detect'
import {
  parseHover,
  parseLocations,
  workspaceRelativeTarget,
  type PluginLocation
} from './plugin-language-feature-replies'
import { getConnectionIdForFile } from './connection-context'
import { getRuntimeTargetForFileOwner } from './file-owner-runtime-target'
import { getOpenedEditFileIdAfterOpen } from '@/store/slices/editor/file-ids/editor-file-ids'
import { scheduleEditorLineReveal } from '@/store/slices/editor/focus/editor-focus-reveal'

type MonacoApi = typeof Monaco
type LanguageMethod = 'hover' | 'definition' | 'references'

// Why a distinct fragment: Orca keys its own tab models by `file:` URI + owner-key fragment, and a
// fragment-less model would be adopted (with stale text) when the user later opens that file.
const PEEK_MODEL_FRAGMENT = 'orca-plugin-peek'
// Why a FIFO cap: peek models outlive the peek widget; this bounds them without tracking widget lifetimes.
const PEEK_MODEL_LIMIT = 50

// Why: Monaco's built-in TS worker only sees the current file; when a plugin answers for the
// language, its single-file results would duplicate or contradict the project-wide ones.
const BUILT_IN_DEFAULTS: Record<string, typeof monacoTS.typescriptDefaults> = {
  typescript: monacoTS.typescriptDefaults,
  javascript: monacoTS.javascriptDefaults
}

/** The open edit tab for a path; its worktree and host own every cross-file target. */
function findEditTab(filePath: string): OpenFile | undefined {
  return useAppStore
    .getState()
    .openFiles.find((file) => file.mode === 'edit' && file.filePath === filePath)
}

/** Calls the plugin's worker command; failures resolve to null so the editor shows nothing. */
async function askPlugin(
  feature: ActivePluginLanguageFeature,
  method: LanguageMethod,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position
): Promise<unknown> {
  if (model.uri.scheme !== 'file') {
    return null
  }
  try {
    const result = await window.api.plugins.invokeCommand({
      pluginKey: feature.pluginKey,
      commandId: feature.command,
      args: {
        method,
        filePath: model.uri.fsPath,
        content: model.getValue(),
        line: position.lineNumber,
        column: position.column
      }
    })
    return result ?? null
  } catch (error) {
    console.warn(`[plugin:${feature.pluginKey}] ${method} failed`, error)
    return null
  }
}

/** Maps plugin locations to Monaco locations, dropping targets outside the source workspace. */
export function createLocationMapper(
  monaco: MonacoApi
): (
  source: Monaco.editor.ITextModel,
  locations: PluginLocation[]
) => Promise<Monaco.languages.Location[]> {
  const peekModels: Monaco.editor.ITextModel[] = []

  /** Current target text: the live editor model when the file is open (unsaved edits), else a fresh read. */
  async function readTarget(
    tab: OpenFile,
    filePath: string,
    relativePath: string
  ): Promise<string | null> {
    const live = monaco.editor
      .getModels()
      .find(
        (model) =>
          model.uri.scheme === 'file' &&
          model.uri.fragment !== PEEK_MODEL_FRAGMENT &&
          model.uri.fsPath === filePath
      )
    if (live) {
      return live.getValue()
    }
    // Why: read through the source tab's host so SSH and paired-runtime targets come from the right machine.
    const target = getRuntimeTargetForFileOwner(
      useAppStore.getState(),
      tab.worktreeId,
      tab.runtimeEnvironmentId
    )
    if (!target) {
      return null
    }
    try {
      const file = await readRuntimeFileContent({
        target,
        filePath,
        relativePath,
        worktreeId: tab.worktreeId,
        connectionId: getConnectionIdForFile(tab.worktreeId, tab.filePath) ?? undefined,
        expectedExternalSshTargetId: tab.externalSshTargetId
      })
      return file.isBinary ? null : file.content
    } catch {
      return null
    }
  }

  /** Why a model: peek widgets and Cmd-hover previews resolve targets through Monaco's model
   *  registry, so cross-file targets need one or they render empty. Refreshed on every request
   *  so a returned range never lands on stale text. */
  async function uriFor(
    tab: OpenFile,
    filePath: string,
    relativePath: string
  ): Promise<Monaco.Uri> {
    const uri = monaco.Uri.file(filePath).with({ fragment: PEEK_MODEL_FRAGMENT })
    const content = await readTarget(tab, filePath, relativePath)
    const existing = monaco.editor.getModel(uri)
    if (content === null) {
      // Unreadable target: navigation still works through the editor opener, only the preview is empty.
      if (existing) {
        const index = peekModels.indexOf(existing)
        if (index !== -1) {
          peekModels.splice(index, 1)
        }
        existing.dispose()
      }
      return uri
    }
    if (existing) {
      if (existing.getValue() !== content) {
        existing.setValue(content)
      }
      return uri
    }
    peekModels.push(monaco.editor.createModel(content, detectLanguage(filePath), uri))
    if (peekModels.length > PEEK_MODEL_LIMIT) {
      peekModels.shift()?.dispose()
    }
    return uri
  }

  return async (source, locations) => {
    const tab = findEditTab(source.uri.fsPath)
    if (!tab) {
      return []
    }
    // Why: references often hit one file many times; read each target once per request.
    const uris = new Map<string, Promise<Monaco.Uri>>()
    const uriOnce = (filePath: string, relativePath: string): Promise<Monaco.Uri> => {
      const pending = uris.get(filePath) ?? uriFor(tab, filePath, relativePath)
      uris.set(filePath, pending)
      return pending
    }
    const resolved = await Promise.all(
      locations.map(async (location) => {
        if (location.filePath === source.uri.fsPath) {
          return [{ uri: source.uri, range: location.range }]
        }
        const relativePath = workspaceRelativeTarget(tab, location.filePath)
        return relativePath === null
          ? []
          : [
              {
                uri: await uriOnce(location.filePath, relativePath),
                range: location.range
              }
            ]
      })
    )
    return resolved.flat()
  }
}

/** Monaco passes either a range or a position to editor openers. */
function positionOf(selectionOrPosition: Monaco.IRange | Monaco.IPosition | undefined): {
  line: number
  column: number
} {
  if (!selectionOrPosition) {
    return { line: 1, column: 1 }
  }
  return 'startLineNumber' in selectionOrPosition
    ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
    : { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
}

/** Opens cross-file navigation targets as Orca editor tabs in the source file's worktree. */
function openInOrcaEditor(
  source: Monaco.editor.ICodeEditor,
  resource: Monaco.Uri,
  selectionOrPosition?: Monaco.IRange | Monaco.IPosition
): boolean {
  const sourceModel = source.getModel()
  if (resource.scheme !== 'file' || !sourceModel || resource.fsPath === sourceModel.uri.fsPath) {
    return false
  }
  const state = useAppStore.getState()
  const sourceFile = findEditTab(sourceModel.uri.fsPath)
  if (!sourceFile) {
    return false
  }
  const filePath = resource.fsPath
  const relativePath = workspaceRelativeTarget(sourceFile, filePath)
  if (relativePath === null) {
    return false
  }
  const { worktreeId } = sourceFile
  state.openFile(
    {
      filePath,
      relativePath,
      worktreeId,
      runtimeEnvironmentId: sourceFile.runtimeEnvironmentId,
      language: detectLanguage(filePath),
      mode: 'edit'
    },
    {
      preview: true,
      targetGroupId: state.activeGroupIdByWorktree?.[worktreeId],
      recordReplacedPreview: true
    }
  )
  const { line, column } = positionOf(selectionOrPosition)
  const fileId = getOpenedEditFileIdAfterOpen(useAppStore.getState(), filePath, worktreeId)
  scheduleEditorLineReveal(useAppStore.getState, filePath, line, column, fileId)
  return true
}

/** Toggles Monaco's single-file TS hover/definition/references for one language. */
function setBuiltInNavigation(language: string, enabled: boolean): void {
  const defaults = BUILT_IN_DEFAULTS[language]
  if (!defaults || defaults.modeConfiguration.hovers === enabled) {
    return
  }
  defaults.setModeConfiguration({
    ...defaults.modeConfiguration,
    hovers: enabled,
    definitions: enabled,
    references: enabled
  })
}

/**
 * Routes Monaco hover / go to definition / find references to plugins that contribute
 * `languageFeatures` and hold the `editor:languageFeatures` capability. Re-registers whenever
 * the plugin list changes (install, consent, enable/disable).
 */
export function installPluginLanguageFeatures(monaco: MonacoApi): () => void {
  const toLocations = createLocationMapper(monaco)
  let registrations: Monaco.IDisposable[] = []
  let appliedKey = ''

  /** Re-registers providers only when the active contributions actually changed. */
  const apply = (features: ActivePluginLanguageFeature[]): void => {
    const key = JSON.stringify(features)
    if (key === appliedKey) {
      return
    }
    appliedKey = key
    registrations.forEach((registration) => registration.dispose())
    registrations = []
    const covered = new Set(features.flatMap((feature) => feature.languages))
    for (const language of Object.keys(BUILT_IN_DEFAULTS)) {
      setBuiltInNavigation(language, !covered.has(language))
    }
    for (const feature of features) {
      for (const language of feature.languages) {
        registrations.push(
          monaco.languages.registerHoverProvider(language, {
            async provideHover(model, position) {
              const hover = parseHover(await askPlugin(feature, 'hover', model, position))
              return hover ? { contents: [{ value: hover.contents }], range: hover.range } : null
            }
          }),
          monaco.languages.registerDefinitionProvider(language, {
            async provideDefinition(model, position) {
              const found = await askPlugin(feature, 'definition', model, position)
              return toLocations(model, parseLocations(found))
            }
          }),
          monaco.languages.registerReferenceProvider(language, {
            async provideReferences(model, position) {
              const found = await askPlugin(feature, 'references', model, position)
              return toLocations(model, parseLocations(found))
            }
          })
        )
      }
    }
  }

  const opener = monaco.editor.registerEditorOpener({ openCodeEditor: openInOrcaEditor })
  ensurePluginPanelsLoaded()
  apply(collectActivePluginLanguageFeatures(usePluginPanelsStore.getState().plugins))
  const unsubscribe = usePluginPanelsStore.subscribe((state) =>
    apply(collectActivePluginLanguageFeatures(state.plugins))
  )
  return () => {
    unsubscribe()
    opener.dispose()
    apply([])
  }
}
