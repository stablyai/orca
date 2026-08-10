import type { GlobalSettings } from './types'

const MAX_IDENTIFIER_LENGTH = 4_096
const MAX_PATH_LENGTH = 32_768

export type EditorPopoutViewMode = 'source' | 'rich' | 'preview'

export type EditorPopoutDocument = {
  id: string
  filePath: string
  relativePath: string
  worktreeId: string
  language: 'markdown'
  runtimeEnvironmentId?: string | null
  externalSshTargetId?: string
}

export type EditorPopoutOperationContext = {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreeId: string
  worktreePath: string | null
  connectionId?: string
  expectedExecutionHostId: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
  expectedEnvironmentPairingRevision?: number
  expectedExternalSshTargetId?: string
}

export type EditorPopoutOpenRequest = {
  document: EditorPopoutDocument
  content: string
  savedContent: string
  viewMode: EditorPopoutViewMode
  showFrontmatter: boolean
  operationContext: EditorPopoutOperationContext
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined | null {
  if (value === undefined || value === null) {
    return value
  }
  return isBoundedString(value, maxLength) ? value : null
}

function admitDocument(value: unknown): EditorPopoutDocument | null {
  if (!isRecord(value)) {
    return null
  }
  const runtimeEnvironmentId = value.runtimeEnvironmentId
  const externalSshTargetId = optionalBoundedString(
    value.externalSshTargetId,
    MAX_IDENTIFIER_LENGTH
  )
  if (
    !isBoundedString(value.id, MAX_PATH_LENGTH) ||
    !isBoundedString(value.filePath, MAX_PATH_LENGTH) ||
    !isBoundedString(value.relativePath, MAX_PATH_LENGTH) ||
    !isBoundedString(value.worktreeId, MAX_IDENTIFIER_LENGTH) ||
    value.language !== 'markdown' ||
    (runtimeEnvironmentId !== undefined &&
      runtimeEnvironmentId !== null &&
      !isBoundedString(runtimeEnvironmentId, MAX_IDENTIFIER_LENGTH)) ||
    externalSshTargetId === null
  ) {
    return null
  }
  return {
    id: value.id,
    filePath: value.filePath,
    relativePath: value.relativePath,
    worktreeId: value.worktreeId,
    language: 'markdown',
    ...(runtimeEnvironmentId === undefined ? {} : { runtimeEnvironmentId }),
    ...(externalSshTargetId === undefined ? {} : { externalSshTargetId })
  }
}

function isExecutionHostId(value: unknown): value is 'local' | `ssh:${string}` {
  return (
    value === 'local' || (typeof value === 'string' && value.startsWith('ssh:') && value.length > 4)
  )
}

function isEditorPopoutViewMode(value: unknown): value is EditorPopoutViewMode {
  return value === 'source' || value === 'rich' || value === 'preview'
}

function admitSettings(
  value: unknown
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    return undefined
  }
  const runtimeEnvironmentId = value.activeRuntimeEnvironmentId
  if (runtimeEnvironmentId !== null && typeof runtimeEnvironmentId !== 'string') {
    return undefined
  }
  return { activeRuntimeEnvironmentId: runtimeEnvironmentId }
}

function admitOperationContext(value: unknown): EditorPopoutOperationContext | null {
  if (!isRecord(value)) {
    return null
  }
  const settings = admitSettings(value.settings)
  const worktreePath =
    value.worktreePath === null
      ? null
      : isBoundedString(value.worktreePath, MAX_PATH_LENGTH)
        ? value.worktreePath
        : undefined
  const connectionId = optionalBoundedString(value.connectionId, MAX_IDENTIFIER_LENGTH)
  const expectedSshTargetId = optionalBoundedString(
    value.expectedSshTargetId,
    MAX_IDENTIFIER_LENGTH
  )
  const expectedExternalSshTargetId = optionalBoundedString(
    value.expectedExternalSshTargetId,
    MAX_IDENTIFIER_LENGTH
  )
  const generation = value.expectedSshConnectionGeneration
  const pairingRevision = value.expectedEnvironmentPairingRevision
  if (
    settings === undefined ||
    !isBoundedString(value.worktreeId, MAX_IDENTIFIER_LENGTH) ||
    worktreePath === undefined ||
    connectionId === null ||
    expectedSshTargetId === null ||
    expectedExternalSshTargetId === null ||
    !isExecutionHostId(value.expectedExecutionHostId) ||
    (generation !== undefined &&
      (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0)) ||
    (pairingRevision !== undefined &&
      (typeof pairingRevision !== 'number' ||
        !Number.isInteger(pairingRevision) ||
        pairingRevision < 0))
  ) {
    return null
  }
  return {
    settings,
    worktreeId: value.worktreeId,
    worktreePath,
    expectedExecutionHostId: value.expectedExecutionHostId,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(expectedSshTargetId === undefined ? {} : { expectedSshTargetId }),
    ...(generation === undefined ? {} : { expectedSshConnectionGeneration: generation }),
    ...(pairingRevision === undefined
      ? {}
      : { expectedEnvironmentPairingRevision: pairingRevision }),
    ...(expectedExternalSshTargetId === undefined ? {} : { expectedExternalSshTargetId })
  }
}

export function admitEditorPopoutOpenRequest(value: unknown): EditorPopoutOpenRequest | null {
  if (
    !isRecord(value) ||
    typeof value.content !== 'string' ||
    typeof value.savedContent !== 'string' ||
    !isEditorPopoutViewMode(value.viewMode) ||
    typeof value.showFrontmatter !== 'boolean'
  ) {
    return null
  }
  const document = admitDocument(value.document)
  const operationContext = admitOperationContext(value.operationContext)
  if (!document || !operationContext || document.worktreeId !== operationContext.worktreeId) {
    return null
  }
  if (
    document.runtimeEnvironmentId &&
    (operationContext.settings?.activeRuntimeEnvironmentId !== document.runtimeEnvironmentId ||
      operationContext.expectedEnvironmentPairingRevision === undefined)
  ) {
    return null
  }
  if (
    !document.runtimeEnvironmentId &&
    operationContext.expectedEnvironmentPairingRevision !== undefined
  ) {
    return null
  }
  return {
    document,
    content: value.content,
    savedContent: value.savedContent,
    viewMode: value.viewMode,
    showFrontmatter: value.showFrontmatter,
    operationContext
  }
}
