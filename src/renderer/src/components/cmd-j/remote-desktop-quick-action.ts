import { Monitor } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionAvailability, CmdJQuickActionContext } from './quick-action-context'

type Unavailable = Exclude<CmdJQuickActionAvailability, { available: true }>
type Target = { worktreeId: string; environmentId: string; open: (w: string, e: string) => void }

function target(
  ctx: CmdJQuickActionContext
): { ok: true; target: Target } | { ok: false; availability: Unavailable } {
  if (!ctx.activeWorktreeId) {
    return { ok: false, availability: { available: false, reason: 'no-active-workspace' } }
  }
  if (ctx.isLoading) {
    return { ok: false, availability: { available: false, reason: 'loading' } }
  }
  // Unavailable actions are left out of the palette, so this stays hidden outside Orca Cloud.
  if (!ctx.activeCloudEnvironmentId || !ctx.openCloudRemoteDesktop) {
    return { ok: false, availability: { available: false, reason: 'not-cloud-workspace' } }
  }
  return {
    ok: true,
    target: {
      worktreeId: ctx.activeWorktreeId,
      environmentId: ctx.activeCloudEnvironmentId,
      open: ctx.openCloudRemoteDesktop
    }
  }
}

/** "Open remote desktop" for the active Orca Cloud workspace: the same flow as its menu item. */
export function getRemoteDesktopQuickAction(): CmdJQuickAction {
  return {
    id: 'open-cloud-remote-desktop',
    kind: 'action',
    title: translate('components.cloudRemoteDesktop.openMenuItem', 'Open remote desktop'),
    description: translate(
      'components.cloudRemoteDesktop.paletteDescription',
      'Open the sandbox’s desktop in a browser tab.'
    ),
    icon: Monitor,
    verbKeywords: [
      translate('components.cloudRemoteDesktop.verbs.remoteDesktop', 'remote desktop'),
      translate('components.cloudRemoteDesktop.verbs.openDesktop', 'open desktop'),
      translate('components.cloudRemoteDesktop.verbs.vnc', 'vnc'),
      translate('components.cloudRemoteDesktop.verbs.screen', 'screen')
    ],
    isAvailable: (ctx) => {
      const resolved = target(ctx)
      return resolved.ok ? { available: true } : resolved.availability
    },
    run: async (ctx) => {
      const resolved = target(ctx)
      if (!resolved.ok) {
        return { status: 'unavailable', reason: resolved.availability.reason }
      }
      resolved.target.open(resolved.target.worktreeId, resolved.target.environmentId)
      return { status: 'ok' }
    }
  }
}
