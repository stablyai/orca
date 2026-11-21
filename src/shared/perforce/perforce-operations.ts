import type { PerforceBackend } from './perforce-backend'
import {
  requireChangelistId,
  requireChangelistTarget,
  requireDepotPaths,
  requireDescription,
  requireDiscardEntries,
  requireRelativePath,
  requireRelativePathList,
  requireRelativePaths
} from './perforce-arguments'
import type { PerforceEntry } from './perforce-types'

type Params = Readonly<Record<string, unknown>>
type Operation = (backend: PerforceBackend, cwd: string, params: Params) => Promise<unknown>

/**
 * Every Perforce workspace operation by name. Desktop IPC, the SSH relay and the runtime's
 * `perforce.*` methods all dispatch through this table, so each validates its arguments once.
 */
export const PERFORCE_WORKSPACE_OPERATIONS = {
  detect: (b, cwd) => b.detect(cwd),
  info: (b, cwd) => b.info(cwd),
  status: (b, cwd) => b.status(cwd),
  history: (b, cwd, p) => b.history(cwd, typeof p.limit === 'number' ? Math.min(p.limit, 200) : 30),
  diff: (b, cwd, p) => b.diff(cwd, requireRelativePath(p.filePath)),
  diffText: (b, cwd, p) => b.diffText(cwd, requireRelativePaths(p.filePaths)),
  isReadOnlyFile: (b, cwd, p) => b.isReadOnlyFile(cwd, requireRelativePath(p.filePath)),
  checkoutIfReadOnly: (b, cwd, p) => b.checkoutIfReadOnly(cwd, requireRelativePath(p.filePath)),
  open: (b, cwd, p) => b.open(cwd, requireRelativePaths(p.filePaths)),
  edit: (b, cwd, p) => b.edit(cwd, requireRelativePaths(p.filePaths)),
  close: (b, cwd, p) => b.close(cwd, requireRelativePaths(p.filePaths)),
  discard: (b, cwd, p) => b.discard(cwd, requireDiscardEntries(p.entries)),
  submit: (b, cwd, p) => {
    const target = requireChangelistTarget(p.changelist)
    const message =
      target === 'default' ? requireDescription(p.message, 'Submit description') : undefined
    return b.submit(cwd, target, message)
  },
  sync: (b, cwd) => b.sync(cwd),
  shelve: (b, cwd, p) => b.shelve(cwd, requireChangelistId(p.changelist)),
  unshelve: (b, cwd, p) => b.unshelve(cwd, requireChangelistId(p.changelist)),
  unshelveFrom: (b, cwd, p) =>
    b.unshelveFrom(
      cwd,
      requireChangelistId(p.sourceChangelist),
      requireChangelistTarget(p.changelist)
    ),
  shelveAndRevertFiles: (b, cwd, p) =>
    b.shelveAndRevertFiles(
      cwd,
      requireChangelistId(p.changelist),
      requireRelativePaths(p.filePaths)
    ),
  unshelveFiles: (b, cwd, p) =>
    b.unshelveFiles(cwd, requireChangelistId(p.changelist), requireDepotPaths(p.depotPaths)),
  deleteShelf: (b, cwd, p) => b.deleteShelf(cwd, requireChangelistId(p.changelist)),
  deleteChangelistWithFiles: (b, cwd, p) =>
    b.deleteChangelistWithFiles(cwd, requireChangelistId(p.changelist)),
  createChangelist: (b, cwd, p) =>
    b.createChangelist(
      cwd,
      requireDescription(p.description, 'Changelist description'),
      requireRelativePathList(p.filePaths)
    ),
  editDescription: (b, cwd, p) =>
    b.editDescription(
      cwd,
      requireChangelistId(p.changelist),
      requireDescription(p.description, 'Changelist description')
    ),
  moveToChangelist: (b, cwd, p) =>
    b.moveToChangelist(
      cwd,
      requireRelativePaths(p.filePaths),
      requireChangelistTarget(p.changelist)
    ),
  deleteChangelist: (b, cwd, p) => b.deleteChangelist(cwd, requireChangelistId(p.changelist))
} satisfies Record<string, Operation>

export type PerforceOperationName = keyof typeof PERFORCE_WORKSPACE_OPERATIONS

export type PerforceOperationResult<K extends PerforceOperationName> = Awaited<
  ReturnType<(typeof PERFORCE_WORKSPACE_OPERATIONS)[K]>
>

type ChangelistTarget = 'default' | number
type NoParams = Record<never, never>

/** What each operation reads from its request, besides the workspace it runs in. */
export type PerforceOperationParams = {
  detect: NoParams
  info: NoParams
  status: NoParams
  history: { limit?: number }
  diff: { filePath: string }
  diffText: { filePaths: string[] }
  isReadOnlyFile: { filePath: string }
  checkoutIfReadOnly: { filePath: string }
  open: { filePaths: string[] }
  edit: { filePaths: string[] }
  close: { filePaths: string[] }
  discard: { entries: Pick<PerforceEntry, 'path' | 'group' | 'action'>[] }
  submit: { changelist: ChangelistTarget; message?: string }
  sync: NoParams
  shelve: { changelist: number }
  unshelve: { changelist: number }
  unshelveFrom: { sourceChangelist: number; changelist: ChangelistTarget }
  shelveAndRevertFiles: { changelist: number; filePaths: string[] }
  unshelveFiles: { changelist: number; depotPaths: string[] }
  deleteShelf: { changelist: number }
  deleteChangelistWithFiles: { changelist: number }
  createChangelist: { description: string; filePaths: string[] }
  editDescription: { changelist: number; description: string }
  moveToChangelist: { filePaths: string[]; changelist: ChangelistTarget }
  deleteChangelist: { changelist: number }
}

export function isPerforceOperationName(value: unknown): value is PerforceOperationName {
  return typeof value === 'string' && Object.hasOwn(PERFORCE_WORKSPACE_OPERATIONS, value)
}

export const PERFORCE_OPERATION_NAMES: readonly PerforceOperationName[] = Object.keys(
  PERFORCE_WORKSPACE_OPERATIONS
).filter(isPerforceOperationName)

/** Runs operation `name` against `backend` in `cwd`; unknown names and bad arguments reject. */
export async function dispatchPerforceOperation(
  backend: PerforceBackend,
  name: unknown,
  cwd: string,
  params: Params
): Promise<unknown> {
  if (!isPerforceOperationName(name)) {
    throw new Error('Unknown Perforce operation')
  }
  return PERFORCE_WORKSPACE_OPERATIONS[name](backend, cwd, params)
}
