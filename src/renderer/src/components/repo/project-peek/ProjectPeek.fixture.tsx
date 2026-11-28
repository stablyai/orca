import { useAppStore } from '@/store'
import type { RepoUpdate } from '@/store/repos/repo-state'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '../../ui/sonner'
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

const uploadRepo: Repo = {
  ...githubRepo,
  id: 'orca-upload',
  repoIcon: {
    type: 'image',
    src: 'https://github.com/github.png?size=64',
    source: 'upload',
    label: 'logo.png'
  }
}

/** No icon chosen, but a picked color, so Reset is available. */
const noneRepo: Repo = { ...githubRepo, id: 'orca-none', repoIcon: null }

const REPOS = [
  githubRepo,
  forkRepo,
  gitlabRepo,
  folderRepo,
  longRepo,
  lettersRepo,
  noneRepo,
  uploadRepo
]

/** Only the card's appearance fields are applied; that is all it writes. */
function applyAppearance(repoId: string, updates: RepoUpdate): void {
  const appearance: Partial<Repo> = {}
  if ('repoIcon' in updates) {
    appearance.repoIcon = updates.repoIcon
  }
  if (updates.badgeColor !== undefined) {
    appearance.badgeColor = updates.badgeColor
  }
  useAppStore.setState((state) => ({
    repos: state.repos.map((repo) => (repo.id === repoId ? { ...repo, ...appearance } : repo))
  }))
}

// Fixtures have no runtime to persist to, so edits land in the store directly and the card shows them.
const STORE = {
  repos: REPOS,
  updateRepo: async (repoId: string, updates: RepoUpdate): Promise<boolean> => {
    applyAppearance(repoId, updates)
    return true
  }
}

/** A slow host: each edit lands 800ms later, in order, like the real per-repo update chain. */
let slowChain: Promise<unknown> = Promise.resolve()
const SLOW_HOST_STORE = {
  ...STORE,
  updateRepo: (repoId: string, updates: RepoUpdate): Promise<boolean> => {
    const next = slowChain.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
      applyAppearance(repoId, updates)
      return true
    })
    slowChain = next
    return next
  }
}

function Peek({ repo: seeded }: { repo: Repo }): React.JSX.Element {
  const repo = useAppStore((state) => state.repos.find((item) => item.id === seeded.id)) ?? seeded
  return (
    <div className="h-[640px] p-3">
      <ProjectPeekPopover repo={repo}>
        <button type="button" data-testid="mark" className="inline-flex">
          <RepoMark repo={repo} />
        </button>
      </ProjectPeekPopover>
      <Toaster />
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
    // A real click moves focus without a ring; the synthetic one leaves it on the opening tab.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
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

const faviconRepo: Repo = {
  ...githubRepo,
  id: 'orca-site',
  repoIcon: {
    type: 'image',
    src: 'https://www.google.com/s2/favicons?domain=linear.app&sz=64',
    source: 'favicon',
    label: 'Website favicon'
  }
}

const longImageRepo: Repo = {
  ...longRepo,
  id: 'long-image',
  repoIcon: uploadRepo.repoIcon
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const peekButton = (label: string): HTMLElement | undefined =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-slot="popover-content"] button')).find(
    (element) => element.textContent?.includes(label)
  )

const openImageTab = clickTab('Image')

const fetchWebsite = async (frame: HTMLElement): Promise<void> => {
  await openImageTab(frame)
  peekButton('Website icon')?.click()
  await wait(100)
  const input = document.querySelector<HTMLInputElement>('[data-slot="popover-content"] form input')
  if (input) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'linear.app'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  await wait(50)
  peekButton('Fetch')?.click()
  await wait(300)
}

/** Stands in for the favicon request so the fetch outcome is fixed. */
const stubImageLoad = (outcome: 'never' | 'error') => (): void => {
  class StubImage extends Image {
    override set src(_value: string) {
      if (outcome === 'error') {
        setTimeout(() => this.dispatchEvent(new Event('error')), 10)
      }
    }
  }
  window.Image = StubImage
}

export const imageGitHub = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={githubRepo} />,
  interact: openImageTab
})

export const imageWebsite = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={faviconRepo} />,
  interact: openImageTab
})

export const imageUpload = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={uploadRepo} />,
  interact: openImageTab
})

export const imageNone = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={noneRepo} />,
  interact: openImageTab
})

export const imageSizeError = defineFixture({
  width: 380,
  store: STORE,
  setup: () => {
    window.api.shell.pickRepoIconImage = async () => ({
      ok: false,
      error: 'Repo icon image must be 256KB or smaller.',
      errorCode: 'tooLarge'
    })
  },
  render: () => <Peek repo={githubRepo} />,
  interact: async (frame) => {
    await openImageTab(frame)
    peekButton('Upload PNG')?.click()
    await wait(200)
  }
})

export const imageFetching = defineFixture({
  width: 380,
  store: STORE,
  setup: stubImageLoad('never'),
  render: () => <Peek repo={githubRepo} />,
  interact: fetchWebsite
})

export const imageNotFound = defineFixture({
  width: 380,
  store: STORE,
  setup: stubImageLoad('error'),
  render: () => <Peek repo={githubRepo} />,
  interact: fetchWebsite
})

/** The popover's narrowest width, reached on small windows through its viewport cap. */
export const imageNarrowLong = defineFixture({
  width: 380,
  store: STORE,
  render: () => (
    <>
      <style>{'[data-slot="popover-content"] { width: 260px !important; }'}</style>
      <Peek repo={longImageRepo} />
    </>
  ),
  interact: openImageTab
})

export const gearMenu = defineFixture({
  width: 380,
  store: STORE,
  render: () => <Peek repo={githubRepo} />,
  interact: async (frame) => {
    await open(frame)
    const gear = document.querySelector<HTMLElement>(
      '[data-slot="popover-content"] button[aria-label="Options"]'
    )
    gear?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await wait(300)
  }
})

export const slowHost = defineFixture({
  width: 380,
  store: SLOW_HOST_STORE,
  render: () => <Peek repo={githubRepo} />,
  interact: openImageTab
})

/** A slow host with an uploaded image, where the GitHub avatar resolves without a runtime. */
export const slowHostUpload = defineFixture({
  width: 380,
  store: SLOW_HOST_STORE,
  setup: () => {
    // Slow enough to press Reset or Undo before it resolves.
    window.api.gh.repoSlug = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return { owner: 'stablyai', repo: 'orca' }
    }
    window.api.gh.repoUpstream = async () => null
  },
  render: () => <Peek repo={uploadRepo} />,
  interact: openImageTab
})
