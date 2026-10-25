import type { editor } from 'monaco-editor'

type CreateEditor = (
  domElement: HTMLElement,
  options?: editor.IStandaloneEditorConstructionOptions,
  override?: editor.IEditorOverrideServices
) => editor.IStandaloneCodeEditor

type CreateDiffEditor = (
  domElement: HTMLElement,
  options?: editor.IStandaloneDiffEditorConstructionOptions,
  override?: editor.IEditorOverrideServices
) => editor.IStandaloneDiffEditor

type MonacoEditorFactories = {
  editor: {
    create: CreateEditor
    createDiffEditor: CreateDiffEditor
  }
}

type GuardedEditorNamespace = MonacoEditorFactories['editor'] & {
  __orcaWindowsImeInputInstalled?: true
}

function withTextAreaInput<T extends editor.IEditorOptions>(options: T | undefined): T {
  // Why: respect a surface that opts into EditContext explicitly; only change the default.
  if (options?.editContext !== undefined) {
    return options
  }
  return { ...options, editContext: false } as T
}

/**
 * Route Monaco input through its hidden textarea instead of the EditContext API on Windows.
 *
 * Why: Monaco 0.55 enables EditContext by default in Chromium, and on Windows Microsoft Pinyin
 * never draws its candidate window for an EditContext-backed editor — the preedit renders, but
 * there is nothing to pick a character from (#23360). It is IME-specific: Microsoft's Japanese
 * IME draws its candidates on both paths. The terminal takes input through a textarea, where
 * Pinyin works. VS Code users hit the same thing (microsoft/vscode#259380, #285013); the
 * workaround there is `editor.editContext: false`.
 */
export function installMonacoWindowsImeInput(monaco: MonacoEditorFactories, isWindows: boolean): void {
  const editorNamespace = monaco.editor as GuardedEditorNamespace
  if (!isWindows || editorNamespace.__orcaWindowsImeInputInstalled) {
    return
  }

  const create = editorNamespace.create.bind(editorNamespace)
  const createDiffEditor = editorNamespace.createDiffEditor.bind(editorNamespace)
  editorNamespace.create = ((domElement, options, override) =>
    create(domElement, withTextAreaInput(options), override)) as CreateEditor
  // Why: diff editor options flow into both of its code editors, so one default covers each side.
  editorNamespace.createDiffEditor = ((domElement, options, override) =>
    createDiffEditor(domElement, withTextAreaInput(options), override)) as CreateDiffEditor
  editorNamespace.__orcaWindowsImeInputInstalled = true
}
