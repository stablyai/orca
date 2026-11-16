import type { editor } from 'monaco-editor'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { resolveHostPlatform, targetOnHost } from '@/runtime/hosts/platform/execution-host-facts'
import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import type { ParsedExecutionHost } from '../../../../../../shared/execution-host/execution-host'
import { isWslHostRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  resolveNewModelLineEnding,
  type EditorLineEnding
} from '../../../../../../shared/editor/saving/editor-end-of-line'
import { resolveEditorModelOwner } from '../identity/editor-model-owner'
import {
  beginProgrammaticContentSync,
  endProgrammaticContentSync
} from './monaco-programmatic-sync'

/** OS of the host that owns an open file; null while that host has not reported it. */
export function resolveEditorFileHostPlatform(
  state: AppState,
  file: Pick<
    OpenFile,
    | 'worktreeId'
    | 'filePath'
    | 'runtimeEnvironmentId'
    | 'externalSshTargetId'
    | 'operationProvenance'
  >
): NodeJS.Platform | null {
  const owner = resolveEditorModelOwner(file, state)
  if (!owner.hostId) {
    return null
  }
  const target = targetOnHost(state, file.worktreeId, owner.hostId)
  const fact = resolveHostPlatform(state, {
    ...target,
    // The owner already names the runtime that reaches an `ssh:` host; null means direct.
    sshOwnerEnvironmentId: target.host?.kind === 'ssh' ? owner.environmentId : null,
    // The file path refines local and server WSL namespaces.
    workspacePath: file.filePath,
    projectRuntime: () => getLocalProjectExecutionRuntimeContext(state, file.worktreeId)
  })
  if (fact.kind === 'known') {
    return fact.platform
  }
  // Why: a WSL host's server always runs inside the distro, even before it reports its OS.
  return isWslHostRuntime(state, target.host) ? 'linux' : null
}

function isWslHostRuntime(state: AppState, host: ParsedExecutionHost | null): boolean {
  if (host?.kind !== 'runtime') {
    return false
  }
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === host.environmentId)
  return Boolean(environment && isWslHostRuntimeEnvironment(environment))
}

export function resolveOpenFileNewModelLineEnding(
  state: AppState,
  fileId: string,
  language: string
): EditorLineEnding | null {
  const file = state.openFiles?.find((entry) => entry.id === fileId)
  if (!file) {
    return null
  }
  const setting = state.settings?.editorEndOfLine
  return resolveNewModelLineEnding({
    setting,
    // Explicit LF/CRLF needs no host lookup.
    hostPlatform:
      setting === 'lf' || setting === 'crlf' ? null : resolveEditorFileHostPlatform(state, file),
    language
  })
}

type LineEndingModel = Pick<editor.ITextModel, 'getLineCount' | 'getEOL' | 'setEOL'>

/** Sets the ending of a model that has no line breaks yet; models with breaks keep theirs. */
export function applyNewModelLineEnding(
  model: LineEndingModel,
  lineEnding: EditorLineEnding | null,
  modelKey: string
): void {
  if (!lineEnding || model.getLineCount() > 1 || model.getEOL() === lineEnding) {
    return
  }
  // An EOL switch emits a content event; keep it from marking the file dirty.
  beginProgrammaticContentSync(modelKey)
  try {
    // Literal EndOfLineSequence values (LF = 0, CRLF = 1) keep this free of the Monaco runtime.
    model.setEOL(lineEnding === '\r\n' ? 1 : 0)
  } finally {
    endProgrammaticContentSync(modelKey)
  }
}
