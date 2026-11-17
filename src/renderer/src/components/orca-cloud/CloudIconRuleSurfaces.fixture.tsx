import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import type { Repo } from '../../../../shared/repository/repo-types'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { Command, CommandList } from '../ui/command'
import { PendingWorktreeRow } from '../sidebar/worktree-list/rows/PendingWorktreeRow'
import { WorktreeJumpPaletteWorktreeRow } from '../worktree-jump/rows/worktree-jump-palette-worktree-row'
import type { WorktreeJumpPaletteController } from '../worktree-jump/use-worktree-jump-palette-controller'
import type { WorktreePaletteItem } from '../worktree-jump/worktree-jump-palette-model'
import { makeRepo, makeWorktree } from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { NativeChatComposerWorkspace } from '../native-chat/composer/controls/NativeChatComposerWorkspace'

const repo: Repo = { ...makeRepo(), displayName: 'orca' }
const cloudRow = makeWorktree('cloud-asleep', 'Support excalidraw files', {
  branch: 'refs/heads/support-excalidraw'
})
const cloudRunning = makeWorktree('cloud-running', 'Fix auth redirect', {
  branch: 'refs/heads/fix-auth-redirect'
})
const localRow = makeWorktree('local-a', 'Tidy settings copy', { branch: 'refs/heads/tidy' })

const status = (state: HostedWorkspaceStatus['state']): HostedWorkspaceStatus => ({
  state,
  metrics: null,
  uptimeMs: null,
  usage: { totalMs: 3_600_000, centsPerHour: 100, costCents: 100 },
  archive: null,
  checkedAt: Date.now()
})

function seedCloud(): void {
  const entries = { 'cloud-asleep': status('sleeping'), 'cloud-running': status('ready') }
  seedCloudWorkspaceSnapshot({
    ids: new Set(Object.keys(entries)),
    idsLoaded: true,
    status: Object.fromEntries(
      Object.entries(entries).map(([id, value]) => [
        id,
        { status: value, loading: false, error: null, fetchedAt: Date.now() }
      ])
    )
  })
}

const request = (name: string): PendingWorktreeCreation['request'] =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pending row reads only these fields.
  ({
    repoId: repo.id,
    name,
    displayName: name,
    ephemeralVmRecipe: {
      sourceRepoId: repo.id,
      recipeId: 'orca-cloud',
      projectId: 'proj-1',
      provider: 'orca-cloud'
    }
  }) as unknown as PendingWorktreeCreation['request']

const creation = (
  creationId: string,
  name: string,
  over: Partial<PendingWorktreeCreation> = {}
): PendingWorktreeCreation => ({
  creationId,
  phase: 'provisioning-vm',
  status: 'creating',
  startedAt: Date.now() - 18_000,
  indeterminate: true,
  loaderVisible: false,
  request: request(name),
  ...over
})

/** Creating an Orca Cloud workspace: the Cloud glyph from the first frame, starting / failed badge. */
export const creatingCloudRow = defineFixture({
  width: 300,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [repo],
    pendingWorktreeCreations: {
      starting: creation('starting', 'Bump Electron'),
      failed: creation('failed', 'Migrate billing', {
        status: 'error',
        error: 'The sandbox could not start.'
      })
    }
  },
  render: () => (
    <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
      <PendingWorktreeRow creationId="starting" repoName="orca" />
      <PendingWorktreeRow creationId="failed" repoName="orca" />
    </div>
  )
})

const match = (worktreeId: string): WorktreePaletteItem['match'] => ({
  worktreeId,
  matchedFields: [],
  displayNameRanges: [],
  branchRanges: [],
  repoRanges: [],
  hostRanges: [],
  supportingText: null,
  qualityClass: null,
  rank: null,
  lastActiveAt: null,
  activity: { ageBucket: null, timestamp: 0 }
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only these fields.
const controller = {
  repoMap: new Map([[repo.id, repo]]),
  repoByHostIdentity: new Map(),
  activeWorktreeId: null,
  sshConnectionStates: new Map(),
  hostOptions: [],
  hostFilterActive: false,
  hasQuery: false,
  lastVisitedAtByWorktreeId: {},
  paletteNowMs: Date.now(),
  activeWorkspaceExecutionHostId: null,
  handleSelectItem: () => {}
} as unknown as WorktreeJumpPaletteController

/** Cmd-J rows: cloud workspaces lead with Cloud + state badge; local shows Monitor once mixed. */
export const paletteRows = defineFixture({
  width: 560,
  store: { settings: getDefaultSettings('/home/fixture'), repos: [repo] },
  setup: seedCloud,
  render: () => (
    <Command>
      <CommandList>
        {[cloudRunning, cloudRow, localRow].map((worktree) => (
          <WorktreeJumpPaletteWorktreeRow
            key={worktree.id}
            renderKey={worktree.id}
            entry={{ id: worktree.id, type: 'worktree', match: match(worktree.id), worktree }}
            controller={controller}
          />
        ))}
      </CommandList>
    </Command>
  )
})

/** Chat composer footer on a cloud workspace: Cloud glyph + "Orca Cloud", not a Server. */
export const composerFooter = defineFixture({
  width: 720,
  store: {
    settings: getDefaultSettings('/home/fixture'),
    repos: [repo],
    worktreesByRepo: { [repo.id]: [cloudRow] }
  },
  setup: seedCloud,
  render: () => (
    <div className="bg-chat-canvas p-3">
      <NativeChatComposerWorkspace
        terminalTabId="tab-1"
        structuredTransport={{ worktreeId: cloudRow.id, runtimeEnvironmentId: null }}
      />
    </div>
  )
})
