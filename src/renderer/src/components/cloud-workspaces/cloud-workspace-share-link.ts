// A cloud workspace's share link: the org slug + W-number link when known, else the sandbox-id form.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { cloudWorkspaceShareLink } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { cloudWorkspaceIdentity, rememberCloudWorkspaces } from './cloud-workspace-identity'

// How long Copy link waits on the control plane before settling for the sandbox-id link.
const LINK_LOOKUP_MS = 3_000

async function lookUpLink(id: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const fetched = await Promise.race([
      window.api.cloudWorkspaces.get(id),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), LINK_LOOKUP_MS)
      })
    ])
    if (!fetched?.ok) {
      return null
    }
    rememberCloudWorkspaces([fetched.value])
    return fetched.value.link ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The org slug + W-number link when the control plane gave one, else the sandbox id form, which
 * opens for anyone with access. Never rejects: a device that didn't create the workspace (paired,
 * offline, signed out) still gets a working link.
 */
export async function shareLinkFor(id: string, chatId?: string | null): Promise<string> {
  const link = cloudWorkspaceIdentity(id)?.link ?? (await lookUpLink(id))
  return cloudWorkspaceShareLink({ id, ...(link ? { link } : {}) }, chatId)
}

export async function copyCloudWorkspaceLink(
  id: string,
  chatId?: string | null,
  options: { quiet?: boolean } = {}
): Promise<boolean> {
  const link = await shareLinkFor(id, chatId)
  try {
    // Why: main-process clipboard, like every other renderer copy. navigator.clipboard needs a
    // focused document with live user activation; after the link lookup (or from the menu or a
    // shortcut) Electron rejects it with "Document is not focused".
    await window.api.ui.writeClipboardText(link)
  } catch (error) {
    console.warn('[cloud-workspaces] copy link failed', error)
    toast.error(
      translate('auto.components.cloudWorkspaces.copyFailed', "Couldn't copy the link. Try again.")
    )
    return false
  }
  if (options.quiet) {
    return true
  }
  toast.success(
    chatId
      ? translate('auto.components.cloudWorkspaces.chatLinkCopied', 'Chat link copied')
      : translate('auto.components.cloudWorkspaces.workspaceLinkCopied', 'Workspace link copied')
  )
  return true
}
