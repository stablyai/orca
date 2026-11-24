import type { Repo } from '../../../../../shared/repository/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RepoMark } from '../RepoMark'
import { ProjectPeekPopover } from './ProjectPeekPopover'

const avatar = {
  type: 'image',
  src: 'https://github.com/stablyai.png?size=64',
  source: 'github',
  label: 'stablyai/orca'
} as const

const githubRepo: Repo = {
  id: 'orca',
  path: '/Users/nwparker/orca/workspaces/orca/sidebar-squashed',
  displayName: 'orca',
  badgeColor: '#8b5cf6',
  repoIcon: avatar,
  addedAt: 1,
  worktreeBaseRef: 'origin/main',
  upstream: null,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/stablyai/orca',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:stablyai/orca.git'
  }
}

const forkRepo: Repo = {
  ...githubRepo,
  id: 'pi-mono',
  path: '/Users/nwparker/code/pi-mono',
  displayName: 'pi-mono',
  badgeColor: '#737373',
  repoIcon: null,
  addedAt: 2,
  upstream: { owner: 'badlogic', repo: 'pi-mono' },
  gitRemoteIdentity: {
    canonicalKey: 'github.com/nwparker/pi-mono',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/nwparker/pi-mono.git'
  }
}

const gitlabRepo: Repo = {
  id: 'infra',
  path: '/home/ubuntu/src/platform/infrastructure/terraform-modules',
  displayName: 'terraform-modules',
  badgeColor: '#14b8a6',
  repoIcon: { type: 'lucide', name: 'Server' },
  addedAt: 3,
  connectionId: 'devbox',
  worktreeBaseRef: 'origin/develop',
  gitRemoteIdentity: {
    canonicalKey: 'gitlab.acme.dev/platform/infrastructure/terraform-modules',
    remoteName: 'origin',
    remoteUrl: 'git@gitlab.acme.dev:platform/infrastructure/terraform-modules.git'
  }
}

const folderRepo: Repo = {
  id: 'notes',
  path: '/Users/nwparker/Documents/notes',
  displayName: 'notes',
  badgeColor: '#737373',
  repoIcon: { type: 'emoji', emoji: '📝' },
  addedAt: 4,
  kind: 'folder'
}

const longRepo: Repo = {
  id: 'long',
  path: '/Users/nwparker/orca/workspaces/orca-internal/customer-onboarding-flow-redesign-with-billing-migration',
  displayName: 'customer-onboarding-flow-redesign-with-billing-migration',
  badgeColor: '#0ea5e9',
  repoIcon: { type: 'lucide', name: 'Rocket' },
  addedAt: 5,
  worktreeBaseRef: 'origin/release/2026-11-hotfix-candidate',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/stablyai/customer-onboarding-flow-redesign',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:stablyai/customer-onboarding-flow-redesign.git'
  }
}

const lettersRepo: Repo = {
  id: 'orca-internal',
  path: '/Users/nwparker/code/orca-internal',
  displayName: 'orca-internal',
  badgeColor: '#737373',
  repoIcon: { type: 'letters', text: 'OI' },
  addedAt: 6
}

const REPOS = [githubRepo, forkRepo, gitlabRepo, folderRepo, longRepo, lettersRepo]

const STORE = { repos: REPOS }

function Peek({ repo }: { repo: Repo }): React.JSX.Element {
  return (
    <div className="h-[640px] p-3">
      <ProjectPeekPopover repo={repo}>
        <button type="button" data-testid="mark" className="inline-flex">
          <RepoMark repo={repo} />
        </button>
      </ProjectPeekPopover>
    </div>
  )
}

const open = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLElement>('[data-testid="mark"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const clickTile =
  (label: string) =>
  async (frame: HTMLElement): Promise<void> => {
    await open(frame)
    document
      .querySelector<HTMLElement>(`[data-slot="popover-content"] button[aria-label="${label}"]`)
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }

// Radix tabs switch on mousedown, not click.
const clickTab =
  (name: string) =>
  async (frame: HTMLElement): Promise<void> => {
    await open(frame)
    const tab = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="popover-content"] [role="tab"]')
    ).find((element) => element.textContent?.trim() === name)
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

export const github = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={githubRepo} />,
  interact: open
})

export const fork = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={forkRepo} />,
  interact: open
})

export const sshGitlab = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={gitlabRepo} />,
  interact: open
})

export const folder = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={folderRepo} />,
  interact: open
})

export const longEverything = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={longRepo} />,
  interact: open
})

export const emojiSource = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={folderRepo} />,
  interact: clickTile('Emoji')
})

export const lettersEdit = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={lettersRepo} />,
  interact: open
})

export const picturePanel = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={githubRepo} />,
  interact: clickTab('Picture')
})
