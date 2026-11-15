// CREATE-GH-STEP: what the create wizard's GitHub access step shows, from the control plane's
// repo-access answer (its `push` reason) and, where it decides the button, the person's install rights.
import type { HostedGithubRepoAccessResponse } from '../../../../shared/hosted-sandbox/hosted-github-wire'
import { fetchCloudPushAccess } from './cloud-push-access'

/**
 * `install`: Install GitHub App (or connect this account to the owner's installation).
 * `configure`: the App is on the owner without this repository; its settings page adds it.
 * `request`: only an owner can install; copy a request for one. `requested`: already asked.
 */
export type CloudCreateGitHubAsk = 'install' | 'configure' | 'request' | 'requested'

export type CloudCreateGitHubAccess = {
  repoUrl: string
  /** owner/repo */
  repoName: string
  owner: string
  /**
   * `hidden`: no row (not on GitHub, signed out, or an older control plane that can't say).
   * `ok`: the App could push from the start. `granted`: it can now, after asking.
   */
  phase: 'checking' | 'ok' | 'needed' | 'granted' | 'skipped' | 'hidden'
  ask?: CloudCreateGitHubAsk
  configureUrl?: string
  /** Install (or settings) opened in the browser; GitHub's answer is being polled for. */
  opened: boolean
  /** Skipped on an earlier create of this repository: this create doesn't hold for it. */
  remembered: boolean
  /** The sandbox is up and the create is waiting on this step before Open workspace. */
  holding: boolean
}

export type CloudCreateGitHubGate = { proceed: boolean; grantedDuringCreate: boolean }

/** owner/repo from https://github.com/<owner>/<repo>. */
export function repoNameOf(repoUrl: string): string {
  return repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')
}

export type CloudCreateGitHubEvaluation =
  | { phase: 'ok' | 'hidden' }
  | { phase: 'needed'; ask: CloudCreateGitHubAsk; configureUrl?: string }

export async function evaluateCloudCreateGitHubAccess(
  repoUrl: string,
  answer: HostedGithubRepoAccessResponse | null
): Promise<CloudCreateGitHubEvaluation> {
  if (!answer) {
    return { phase: 'hidden' }
  }
  if (answer.push === 'ok' || answer.access === 'granted') {
    return { phase: 'ok' }
  }
  // An older control plane can't tell pull from push: its toast after create stays the only ask.
  if (answer.push === undefined) {
    return { phase: 'hidden' }
  }
  if (answer.access === 'requested') {
    return { phase: 'needed', ask: 'requested' }
  }
  if (answer.canInstall === false) {
    return { phase: 'needed', ask: 'request' }
  }
  if (answer.push === 'repo_not_selected' && (answer.configureUrl || answer.installUrl)) {
    return {
      phase: 'needed',
      ask: 'configure',
      configureUrl: answer.configureUrl ?? answer.installUrl
    }
  }
  // Same rule as the push notice: the control plane's canInstall, else the person's gh login.
  const access = await fetchCloudPushAccess(repoUrl).catch(() => 'install' as const)
  return {
    phase: 'needed',
    ask: access === 'cantInstall' ? 'request' : access === 'requested' ? 'requested' : 'install'
  }
}
