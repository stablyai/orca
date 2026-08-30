import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Why: the agent's own extension directory is the only place a second status extension can come
// from, so naming the agent is enough for the user to find the file. Orca never touches it.
const AGENT_LABEL_BY_SOURCE: Record<string, string> = {
  omp: 'OMP',
  pi: 'Pi',
  'prime-agent': 'Prime'
}

const notifiedSources = new Set<string>()

/** Reset between tests; the real notice is once-per-source for the life of the window. */
export function resetUnmanagedStatusExtensionNotices(): void {
  notifiedSources.clear()
}

/**
 * Tell the user once per agent that a status extension Orca did not install is being ignored.
 *
 * Why a notice and not a fix: the file is the user's own, so Orca will not remove, move, or
 * rewrite it. Without this the discrimination is invisible and reads as Orca ignoring their
 * extension for no reason.
 */
export function notifyUnmanagedStatusExtension(source: string): void {
  if (!source || notifiedSources.has(source)) {
    return
  }
  notifiedSources.add(source)
  const agent = AGENT_LABEL_BY_SOURCE[source] ?? source
  toast.warning(
    translate(
      'auto.hooks.unmanagedStatusExtensionNotice.title',
      'Ignoring status from an extension Orca did not install'
    ),
    {
      id: `unmanaged-status-extension-${source}`,
      description: translate(
        'auto.hooks.unmanagedStatusExtensionNotice.description',
        'A second copy of orca-agent-status.ts is running in your {{agent}} extensions folder. Orca is ignoring what it reports, because an older copy can mark a turn finished while the agent is still working. Orca has not changed the file — remove or rename it yourself if you no longer want it.',
        { agent }
      ),
      duration: Infinity,
      cancel: {
        label: translate('auto.hooks.unmanagedStatusExtensionNotice.dismiss', 'Dismiss'),
        onClick: () => {}
      }
    }
  )
}
