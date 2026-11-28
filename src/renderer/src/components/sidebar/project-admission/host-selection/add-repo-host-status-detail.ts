import {
  type SidebarHostOption,
  getSidebarHostHealthLabel
} from '../../worktree-list/controls/sidebar-host-options'
import { translateExecutionHostDetail } from '../../../../runtime/hosts/display/execution-host-label'
import { describeRuntimeCompatBlock } from '@/runtime/hosts/display/runtime-host-copy'
import type { Translate } from '@/i18n/use-translate'

export function getAddRepoHostStatusDetail(host: SidebarHostOption, t?: Translate): string {
  // A disabled WSL feature is not a disconnected-host failure.
  if (host.wslUnavailable) {
    return translateExecutionHostDetail(host.detail)
  }
  if (host.compatibility?.kind === 'blocked') {
    return describeRuntimeCompatBlock(host.compatibility, t)
  }
  const detail = host.failureReason ?? translateExecutionHostDetail(host.detail)
  return `${getSidebarHostHealthLabel(host.health, host.blockedReason, t, host.vmState)}${detail ? ` - ${detail}` : ''}`
}
