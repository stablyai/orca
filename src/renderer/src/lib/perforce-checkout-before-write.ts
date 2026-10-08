import { useAppStore } from '@/store'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { normalizePerforceSettings } from '../../../shared/perforce/perforce-settings'
import type { RuntimeFileOperationArgs } from '../runtime/runtime-file-client-types'
import { runPerforceOperation } from '../runtime/runtime-perforce-client'
import { askToOpenForEdit } from './perforce-open-for-edit-prompt'
import { perforceTargetForFile } from './perforce-workspace-target'

export const PERFORCE_EDIT_DECLINED_MESSAGE =
  'Save cancelled: the file is not opened for edit in Perforce.'

/**
 * Perforce leaves synced files read-only until they are opened for edit, so saving one would fail.
 * Before a write into a Perforce workspace, on whichever host it lives, this opens the file for edit
 * as Settings > Perforce says (asking first by default); declining cancels the save. Probe failures
 * fall through to the normal write, which reports the error.
 */
export async function checkoutPerforceFileBeforeWrite(
  context: RuntimeFileOperationArgs,
  filePath: string
): Promise<void> {
  const behavior = normalizePerforceSettings(
    useAppStore.getState().settings?.perforce
  ).saveReadOnlyBehavior
  if (behavior === 'never') {
    return
  }
  const target = await perforceTargetForFile(
    {
      settings: context.settings,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath ?? '',
      ...(context.connectionId ? { connectionId: context.connectionId } : {})
    },
    filePath
  )
  const relativePath = target ? relativePathInsideRoot(target.worktreePath, filePath) : null
  if (!target || !relativePath) {
    return
  }
  const readOnly = await runPerforceOperation(target, 'isReadOnlyFile', {
    filePath: relativePath
  }).catch(() => false)
  if (!readOnly) {
    return
  }
  if (behavior === 'ask' && !(await askToOpenForEdit(relativePath))) {
    throw new Error(PERFORCE_EDIT_DECLINED_MESSAGE)
  }
  // The write reports the failure if the file stayed read-only.
  await runPerforceOperation(target, 'checkoutIfReadOnly', { filePath: relativePath }).catch(
    () => undefined
  )
}
