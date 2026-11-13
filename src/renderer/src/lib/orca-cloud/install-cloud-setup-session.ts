// Plugs the setup session (cloud-setup-session.ts) into the composer's seam (w2-lifecycle):
// "Set up and start" opens the one browser tab, the setup panel reads each poll's snapshot, and a
// draft restored after a restart resumes polling its session.
import { useAppStore } from '@/store'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import { parseRemoteRepo } from '@/components/right-sidebar/source-control/review/remote-repo'
import type { CloudSetupNeed } from '../../../../shared/orca-cloud-setup'
import {
  getCloudSetupSnapshot,
  startCloudSetupSession,
  subscribeCloudSetupSessions,
  watchCloudSetupSession
} from './cloud-setup-session'
import {
  notifyCloudSetupSessionChanged,
  setCloudSetupLinkProvider,
  setCloudSetupSessionSource,
  setCloudSetupStarter
} from './cloud-setup-session-seam'

/** https://github.com/<owner>/<repo> for a project whose remote is on GitHub, else undefined. */
export function githubRepoUrlFor(remoteUrl: string | null | undefined): string | undefined {
  const parsed = remoteUrl ? parseRemoteRepo(remoteUrl) : null
  if (!parsed || parsed.provider !== 'github' || !/^[^/]+\/[^/]+$/.test(parsed.path)) {
    return undefined
  }
  return `https://github.com/${parsed.path}`
}

/** The session's steps: team, plan and github (account comes from signing in on the way). */
export function setupNeedsFrom(needs: readonly string[]): CloudSetupNeed[] {
  return needs.filter(
    (need): need is CloudSetupNeed => need === 'team' || need === 'plan' || need === 'github'
  )
}

/**
 * What the session is asked to run. Signed out, Orca can't check GitHub access yet, so a GitHub
 * project always asks for it: the chain marks it done on its own when access is already there.
 * Without it the browser said "You're all set" while the composer still needed GitHub.
 */
export function sessionNeedsFor(
  needs: readonly string[],
  repoUrl: string | undefined
): CloudSetupNeed[] {
  const steps = setupNeedsFrom(needs)
  if (!repoUrl) {
    // Without a GitHub remote there's nothing to install; D3 covers that case in the composer.
    return steps.filter((need) => need !== 'github')
  }
  return needs.includes('account') && !steps.includes('github') ? [...steps, 'github'] : steps
}

export function installCloudSetupSession(): () => void {
  setCloudSetupSessionSource((sessionId) => {
    const snapshot = getCloudSetupSnapshot(sessionId)
    if (!snapshot) {
      // A draft restored after a restart names a session nobody polls yet: start now.
      watchCloudSetupSession(sessionId)
      return null
    }
    return {
      steps: snapshot.steps,
      finished: snapshot.finished,
      ...(snapshot.error ? { error: snapshot.error } : {}),
      ...(snapshot.team?.name ? { teamName: snapshot.team.name } : {})
    }
  })
  // Copy setup link / Reopen browser: a fresh one-time link to the same session.
  setCloudSetupLinkProvider(async (sessionId) => {
    const result = await window.api.orcaProfiles.cloudSetupLink({ sessionId }).catch(() => null)
    return result?.status === 'ok' ? result.url : null
  })
  setCloudSetupStarter(async (request) => {
    const repo = getIndexedRepoMap(useAppStore.getState().repos).get(request.repoId)
    const repoUrl = githubRepoUrlFor(repo?.gitRemoteIdentity?.remoteUrl)
    return startCloudSetupSession({
      ...(repoUrl ? { repo: repoUrl } : {}),
      needs: sessionNeedsFor(request.needs, repoUrl),
      ...(request.openBrowser === false ? { openBrowser: false } : {})
    })
  })
  const unsubscribe = subscribeCloudSetupSessions(() => notifyCloudSetupSessionChanged())
  return () => {
    unsubscribe()
    setCloudSetupStarter(null)
    setCloudSetupLinkProvider(null)
    setCloudSetupSessionSource(null)
  }
}
