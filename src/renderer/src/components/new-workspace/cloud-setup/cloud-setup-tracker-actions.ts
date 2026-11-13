// What the tracker's buttons do: a fresh one-time setup link (the first one was spent by the
// browser that opened it), opened, or copied from Reopen browser's "Copy link". Without a session
// (rows derived from billing), Reopen re-runs today's setup action and there is no link to copy.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getCloudSetupLinkProvider } from '@/lib/orca-cloud/cloud-setup-session-seam'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'

async function freshLink(sessionId: string): Promise<string | null> {
  const provider = getCloudSetupLinkProvider()
  if (!provider) {
    return null
  }
  try {
    return await provider(sessionId)
  } catch {
    return null
  }
}

function linkUnavailable(): void {
  toast.error(
    translate(
      'components.newWorkspace.cloudSetup.linkUnavailableRetry',
      'Couldn’t get a setup link. Try Continue in browser again.'
    )
  )
}

function canCopyCloudSetupLink(sessionId: string | null): boolean {
  return sessionId !== null && getCloudSetupLinkProvider() !== null
}

/**
 * "Copy link" beside Reopen browser: a fresh one-time link to the same session, minted the way
 * Reopen mints it. Null when there is no session to link to (Reopen then re-runs today's action).
 */
export function cloudSetupLinkSource(sessionId: string | null): ExternalLinkSource | null {
  if (!sessionId || !canCopyCloudSetupLink(sessionId)) {
    return null
  }
  return async () => {
    const url = await freshLink(sessionId)
    if (!url) {
      linkUnavailable()
    }
    return url
  }
}

/** Opens the setup session again; falls back to `rerun` when there's no session link. */
export async function reopenCloudSetup(sessionId: string | null, rerun: () => void): Promise<void> {
  const url = sessionId ? await freshLink(sessionId) : null
  if (!url) {
    rerun()
    return
  }
  await window.api.shell.openUrl(url).catch(() => rerun())
}
