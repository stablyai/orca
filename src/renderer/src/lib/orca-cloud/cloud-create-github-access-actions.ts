// CREATE-GH-STEP: what the GitHub access step's buttons do (cloud-create-github-access.ts holds
// the state, the polls and the hold before Open).
import { entries } from './cloud-create-github-access-registry'
import { schedulePoll, settle, update } from './cloud-create-github-access'
import { openOrcaGitHubAppInstall } from './cloud-setup-notice-actions'
import { forgetGitHubAccessSkip, rememberGitHubAccessSkip } from './cloud-create-github-skip'

/** Install GitHub App / Add the repository on GitHub: opens GitHub, then keeps polling. */
export function openCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'needed') {
    return
  }
  const { repoUrl, configureUrl, ask } = entry.state
  const opened =
    ask === 'configure' && configureUrl
      ? window.api.shell.openUrl(configureUrl).then(
          () => true,
          () => openOrcaGitHubAppInstall(repoUrl)
        )
      : openOrcaGitHubAppInstall(repoUrl)
  void opened.then((ok) => {
    if (ok && entries.get(creationId) === entry) {
      update(creationId, { opened: true })
      // Back from the browser: ask now instead of at the next poll.
      schedulePoll(creationId, 0)
    }
  })
}

/** Orca regained focus (an install finished in the browser): check now. */
export function recheckCloudCreateGitHubAccess(creationId: string): void {
  schedulePoll(creationId, 0)
}

/**
 * "Skip for now" (remembered for the repository) or "Open now, set up later" (`remember: false`,
 * this create only).
 */
export function skipCloudCreateGitHubAccess(
  creationId: string,
  { remember = true }: { remember?: boolean } = {}
): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'needed') {
    return
  }
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  if (remember) {
    rememberGitHubAccessSkip(entry.state.repoUrl)
  }
  update(creationId, { phase: 'skipped', remembered: false, opened: false })
  settle(creationId, { proceed: true, grantedDuringCreate: false })
}

/**
 * "Set up" on a skipped step: asks again (and polls). The create isn't held a second time; a grant
 * that lands before Open still reaches the sandbox.
 */
export function reopenCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'skipped' || !entry.state.ask) {
    return
  }
  forgetGitHubAccessSkip(entry.state.repoUrl)
  entry.neededSince = null
  update(creationId, { phase: 'needed', remembered: false })
  schedulePoll(creationId)
}
