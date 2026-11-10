// The setup panel's GitHub row (cloud-start D1–D3) from useOrcaCloudRepoAccess. The panel shell and
// its row rendering are w2-lifecycle's; this only says what the row is, in the CloudSetupStep shape
// {id:'github', state, detail?}, plus its label, status word and action. Copy is the spec's verbatim.
import { translate } from '@/i18n/i18n'
import { PUSH_TO_GITHUB_URL } from '@/components/worktree-creation/vm-build-repo-actions'
import type { OrcaCloudRepoAccess } from './use-orca-cloud-repo-access'

export type OrcaCloudGitHubSetupRow = {
  step: {
    id: 'github'
    state: 'done' | 'needed' | 'active' | 'pending' | 'failed'
    detail?: string
  }
  /** Row title: "GitHub access", or "GitHub repository" when the project isn't on GitHub (D3). */
  label: string
  /** Trailing status word ("Needed", "Requested", "Done"); absent while checking. */
  status?: string
  /** Second line under the detail (D1/D2). */
  note?: string
  /** In-row button (D3's "How to push"). */
  action?: { kind: 'push-help'; label: string; url: string }
  /** What the panel's primary (⌘↵) button becomes while this row is the blocker (D1). */
  primary?: { kind: 'install'; label: string }
  /** D3 outranks account and plan rows: buying can't fix a project that isn't on GitHub. */
  blocksStart: boolean
}

export function orcaCloudGitHubSetupRow(
  access: Pick<OrcaCloudRepoAccess, 'state' | 'access' | 'repoName' | 'owner' | 'loading'>
): OrcaCloudGitHubSetupRow {
  const label = translate('orcaCloud.setup.github.label', 'GitHub access')
  const repo = access.repoName
  switch (access.state) {
    case 'not-github':
      return {
        step: {
          id: 'github',
          state: 'failed',
          detail: translate(
            'orcaCloud.setup.github.notGithub',
            'Orca Cloud starts from a GitHub repository.'
          )
        },
        label: translate('orcaCloud.setup.github.repositoryLabel', 'GitHub repository'),
        note: translate(
          'orcaCloud.setup.github.notGithubNote',
          'Push this project to GitHub, or pick a repository Orca Cloud can reach from Project.'
        ),
        action: {
          kind: 'push-help',
          label: translate('orcaCloud.setup.github.howToPush', 'How to push'),
          url: PUSH_TO_GITHUB_URL
        },
        blocksStart: true
      }
    case 'pending-approval':
      return {
        step: {
          id: 'github',
          state: 'pending',
          detail: translate(
            'orcaCloud.setup.github.requested',
            'Waiting for an owner of {{owner}} on GitHub to approve Orca Cloud.',
            { owner: access.owner ?? repo.split('/')[0] ?? repo }
          )
        },
        label,
        status: translate('orcaCloud.setup.github.requestedStatus', 'Requested'),
        note: translate(
          'orcaCloud.setup.github.requestedNote',
          'GitHub sent them the request. This workspace starts once they approve, if Orca is open.'
        ),
        blocksStart: true
      }
    case 'needs-install':
      return {
        step: {
          id: 'github',
          state: 'needed',
          detail: translate(
            'orcaCloud.setup.github.missing',
            'Orca Cloud can’t reach {{repo}} yet.',
            { repo }
          )
        },
        label,
        status: translate('orcaCloud.setup.github.neededStatus', 'Needed'),
        note: translate(
          'orcaCloud.setup.github.missingNote',
          'It clones your code from GitHub. Give access to this repository once.'
        ),
        // D1: no button in the row; the panel's primary action opens GitHub's install page.
        primary: {
          kind: 'install',
          label: translate('orcaCloud.setup.github.giveAccessAndStart', 'Give access and start')
        },
        blocksStart: true
      }
    case 'ok':
      return {
        step: {
          id: 'github',
          state: 'done',
          detail:
            access.access === 'public'
              ? translate('orcaCloud.setup.github.public', '{{repo}} is public. Nothing to do.', {
                  repo
                })
              : repo
        },
        label,
        status: translate('orcaCloud.setup.github.doneStatus', 'Done'),
        blocksStart: false
      }
    default:
      // Checking (Skeleton), or couldn't tell (signed out, offline): never blocks; the create path
      // still refuses an unreachable repository before any sandbox starts.
      return { step: { id: 'github', state: 'active' }, label, blocksStart: false }
  }
}
