import type * as monaco from 'monaco-editor'

type WorktreeContext = {
  worktreeRoot: string
  filePath: string
  connectionId?: string
  // Why: lets a clean file skip shipping its buffer to the sidecar (see buildReferenceRequest).
  isDirty: boolean
}

let worktreeResolver: (model: monaco.editor.ITextModel) => WorktreeContext | null = () => null
let enabledGetter: () => boolean = () => false

export function setCodeIntelEditorContext(
  resolver: (model: monaco.editor.ITextModel) => WorktreeContext | null,
  isEnabled: () => boolean
): void {
  worktreeResolver = resolver
  enabledGetter = isEnabled
}

export function resolveCodeIntelWorktree(model: monaco.editor.ITextModel): WorktreeContext | null {
  return worktreeResolver(model)
}

export function isCodeIntelEnabled(): boolean {
  return enabledGetter()
}
