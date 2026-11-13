// "Copy request for an owner" (REQUEST-COPY-SHARE): someone who can't install the Orca GitHub App
// copies a message for an owner of the repository's org, with the install page that preselects
// the repository. Shared by the refused-clone card (CLONE-ACCESS-ERROR) and the push notice.
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { fetchOrcaCloudRepoAccess } from './use-orca-cloud-repo-access'

/** What the access is for: starting workspaces from the repository, or pushing from them. */
export type OwnerRequestPurpose = 'start' | 'push'

/** How long "Copied" stays on the button. */
export const OWNER_REQUEST_COPIED_MS = 1_500

function repoSlugOf(repoUrl: string): string {
  return repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
}

function requestMessage(repo: string, purpose: OwnerRequestPurpose): string {
  return purpose === 'push'
    ? translate(
        'orcaCloud.ownerRequest.messagePush',
        'Could you give the Orca GitHub App access to {{repo}}? Orca Cloud needs it to push from workspaces on this repository.',
        { repo }
      )
    : translate(
        'orcaCloud.ownerRequest.messageStart',
        'Could you give the Orca GitHub App access to {{repo}}? Orca Cloud needs it to start workspaces from this repository.',
        { repo }
      )
}

/** Copies the request with the install link from the repo-access answer, when it has one. */
export async function copyOwnerRequest(
  repoUrl: string,
  purpose: OwnerRequestPurpose
): Promise<boolean> {
  const link = (await fetchOrcaCloudRepoAccess(repoUrl).catch(() => null))?.installUrl ?? null
  const message = requestMessage(repoSlugOf(repoUrl), purpose)
  try {
    await window.api.ui.writeClipboardText(link ? `${message}\n${link}` : message)
    return true
  } catch {
    toast.error(translate('orcaCloud.ownerRequest.copyFailed', 'Couldn’t copy it.'))
    return false
  }
}

/** The button's label: "Copied" for a moment after a copy. */
export function ownerRequestLabel(copied: boolean, t: Translate): string {
  return copied
    ? t('orcaCloud.ownerRequest.copied', 'Copied')
    : t('orcaCloud.ownerRequest.copy', 'Copy request for an owner')
}

/** Copy the request, and say "Copied" on the button for OWNER_REQUEST_COPIED_MS. */
export function useOwnerRequestCopy(
  repoUrl: string | null,
  purpose: OwnerRequestPurpose
): { copy: () => void; copied: boolean } {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(() => {
    if (!repoUrl) {
      return
    }
    void copyOwnerRequest(repoUrl, purpose).then((ok) => {
      if (ok) {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), OWNER_REQUEST_COPIED_MS)
      }
    })
  }, [purpose, repoUrl])
  return { copy, copied }
}
