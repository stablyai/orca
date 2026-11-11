// What the tracker's buttons do: a fresh one-time setup link (the first one was spent by the
// browser that opened it), copied or opened. Without a session (rows derived from billing), Reopen
// re-runs today's setup action and there is no link to copy.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getCloudSetupLinkProvider } from '@/lib/orca-cloud/cloud-setup-session-seam'

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

export function canCopyCloudSetupLink(sessionId: string | null): boolean {
  return sessionId !== null && getCloudSetupLinkProvider() !== null
}

export async function copyCloudSetupLink(sessionId: string): Promise<void> {
  const url = await freshLink(sessionId)
  if (!url) {
    linkUnavailable()
    return
  }
  try {
    await window.api.ui.writeClipboardText(url)
    toast.success(
      translate(
        'components.newWorkspace.cloudSetup.linkCopied',
        'Setup link copied. Open it in the browser you use for Orca.'
      )
    )
  } catch {
    linkUnavailable()
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
