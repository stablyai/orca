import { isOrcaCliAvailableForLaunch } from '@/lib/orca-cli-launch-availability'
import { getLaunchableWorkItemDraftContent } from '@/lib/linked-work-item-context'
import type { LaunchableWorkItem } from '@/lib/launch-work-item-direct-types'

export async function getDirectWorkItemDraftContent(
  item: LaunchableWorkItem,
  repoConnectionId: string | null
): Promise<string> {
  const cliAvailable = item.linearIdentifier
    ? await isOrcaCliAvailableForLaunch({ remote: repoConnectionId !== null })
    : false
  return getLaunchableWorkItemDraftContent({ ...item, cliAvailable })
}
