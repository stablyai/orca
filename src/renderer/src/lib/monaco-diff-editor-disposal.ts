import type { editor } from 'monaco-editor'

type CreateDiffEditor = (
  domElement: HTMLElement,
  options?: editor.IStandaloneDiffEditorConstructionOptions,
  override?: editor.IEditorOverrideServices
) => editor.IStandaloneDiffEditor

type MonacoDiffEditorNamespace = {
  editor: {
    createDiffEditor: CreateDiffEditor
  }
}

type GuardedDiffEditor = editor.IStandaloneDiffEditor & {
  __orcaDiffEditorDisposeGuardInstalled?: true
}

type GuardedEditorNamespace = MonacoDiffEditorNamespace['editor'] & {
  __orcaDiffEditorFactoryGuardInstalled?: true
}

type DisposeErrorReporter = (error: unknown) => void

function reportMonacoDiffDisposeError(error: unknown): void {
  console.warn('[monaco] Diff editor disposal threw after teardown was requested', error)
}

export function guardMonacoDiffEditorDispose(
  diffEditor: editor.IStandaloneDiffEditor,
  reportError: DisposeErrorReporter = reportMonacoDiffDisposeError
): editor.IStandaloneDiffEditor {
  const guardedDiffEditor = diffEditor as GuardedDiffEditor
  if (guardedDiffEditor.__orcaDiffEditorDisposeGuardInstalled) {
    return diffEditor
  }

  const originalDispose = diffEditor.dispose.bind(diffEditor)
  let didDispose = false

  guardedDiffEditor.dispose = () => {
    if (didDispose) {
      return
    }
    didDispose = true

    try {
      originalDispose()
    } catch (error) {
      // Why: Monaco's DisposableStore throws AggregateError after attempting
      // teardown; letting it escape React cleanup can crash the renderer.
      reportError(error)
    }
  }
  guardedDiffEditor.__orcaDiffEditorDisposeGuardInstalled = true

  return diffEditor
}

export function installMonacoDiffEditorDisposalGuard(
  monaco: MonacoDiffEditorNamespace,
  reportError?: DisposeErrorReporter
): void {
  const editorNamespace = monaco.editor as GuardedEditorNamespace
  if (editorNamespace.__orcaDiffEditorFactoryGuardInstalled) {
    return
  }

  const createDiffEditor = editorNamespace.createDiffEditor.bind(editorNamespace)
  editorNamespace.createDiffEditor = ((...args: Parameters<CreateDiffEditor>) =>
    guardMonacoDiffEditorDispose(createDiffEditor(...args), reportError)) as CreateDiffEditor
  editorNamespace.__orcaDiffEditorFactoryGuardInstalled = true
}
