import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { worktreeOwnerRowsTokenOf } from '@/lib/worktree-owner-rows-token'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { editorBufferIdentityOf } from './editor-buffer-identity'

/** Route state plus the counter bumped when the runtime revision registry changes. */
export type EditorBufferRouteState = WorktreeOperationRouteState & {
  editorBufferIdentityRevision?: number
}

/** Every state field a file's identity can read; a change by reference re-resolves identities. */
export const EDITOR_BUFFER_ROUTE_INPUT_KEYS = [
  'repos',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds',
  'runtimeEnvironments',
  'settings',
  'editorBufferIdentityRevision'
] as const satisfies readonly (keyof EditorBufferRouteState)[]

type RouteInputs = readonly unknown[]

let epochInputs: RouteInputs = []
let epochToken: object = {}

function routeInputOf(
  state: Partial<EditorBufferRouteState>,
  key: (typeof EDITOR_BUFFER_ROUTE_INPUT_KEYS)[number]
): unknown {
  return key === 'worktreesByRepo'
    ? worktreeOwnerRowsTokenOf(selectWorktreesByRepo(state))
    : state[key]
}

function routeInputsOf(state: EditorBufferRouteState): RouteInputs {
  return EDITOR_BUFFER_ROUTE_INPUT_KEYS.map((key) => routeInputOf(state, key))
}

/** Whether two states resolve every editor route identically. */
export function editorBufferRouteInputsEqual(
  a: EditorBufferRouteState,
  b: EditorBufferRouteState
): boolean {
  return EDITOR_BUFFER_ROUTE_INPUT_KEYS.every(
    (key) => a[key] === b[key] || routeInputOf(a, key) === routeInputOf(b, key)
  )
}

/** One token per distinct set of route inputs, so a keystroke resolves no routes. */
export function editorBufferRouteEpochOf(state: EditorBufferRouteState): object {
  const inputs = routeInputsOf(state)
  if (
    inputs.length !== epochInputs.length ||
    inputs.some((input, index) => input !== epochInputs[index])
  ) {
    epochInputs = inputs
    epochToken = {}
  }
  return epochToken
}

const identityCache = new WeakMap<OpenFile, { epoch: object; key: string | null }>()

/** The file's identity key, cached per tab object and route inputs. */
export function editorBufferIdentityKeyOf(
  file: OpenFile,
  state: EditorBufferRouteState
): string | null {
  const epoch = editorBufferRouteEpochOf(state)
  const cached = identityCache.get(file)
  if (cached?.epoch === epoch) {
    return cached.key
  }
  const key = editorBufferIdentityOf(file, state)?.key ?? null
  identityCache.set(file, { epoch, key })
  return key
}

/** Edit views use identity keys; nonedit views own records. Host mirrors share only with mirrors because host owns their buffer state. */
export function editorBufferIdForFile(file: OpenFile, state: EditorBufferRouteState): string {
  const key = editorBufferIdentityKeyOf(file, state)
  if (key === null) {
    return file.id
  }
  return file.mirroredFromRuntimeSession === true ? `mirrored:${key}` : key
}

/** Whether `write` replaces a route input of `state`. */
export function editorBufferRouteInputsChanged(
  state: EditorBufferRouteState,
  write: Partial<EditorBufferRouteState>
): boolean {
  return EDITOR_BUFFER_ROUTE_INPUT_KEYS.some(
    (key) =>
      Object.hasOwn(write, key) &&
      write[key] !== state[key] &&
      routeInputOf(write, key) !== routeInputOf(state, key)
  )
}
