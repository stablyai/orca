// Share with teammates: the team's Google app as a file, from any surface.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { googleAppExportFileName } from '../../../../../shared/google/google-console-setup'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export async function exportGoogleApp(target: RuntimeClientTarget): Promise<string> {
  const { file } = await callRuntimeRpc<{ file: string }>(target, 'google.client.export', {})
  return file
}

/** Share with teammates: the team's app as a file, saved where the person picks. */
export async function saveGoogleAppForTeammates(
  target: RuntimeClientTarget,
  projectId: string | undefined
): Promise<boolean> {
  const text = await exportGoogleApp(target)
  return window.api.googleSetup.saveAppFile({ text, name: googleAppExportFileName(projectId) })
}

/** Share with teammates from any surface: saves the file, then says so in a toast. */
export function shareGoogleApp(target: RuntimeClientTarget, projectId: string | undefined): void {
  void saveGoogleAppForTeammates(target, projectId).then(
    (saved) => {
      if (saved) {
        toast.success(
          translate('bots.google.share.saved', 'Saved. Send the file to your teammates.')
        )
      }
    },
    () => toast.error(translate('bots.google.share.failed', 'Couldn’t save the file. Try again.'))
  )
}
