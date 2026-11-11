import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import {
  setOrcaCloudAgentAccountsStateForTest,
  type OrcaCloudAgentAccountsState
} from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { OrcaCloudAgentsStatus } from '../../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { makeTabWithIds } from '@/components/activity/ActivityPrototypePage-test-fixtures'
import DashboardAgentRowView from '@/components/dashboard/DashboardAgentRow'
import { CompactAgentRow } from './worktree-card-compact-agent-row'

const ENVIRONMENT_ID = 'env-cloud'
const now = 1_792_983_600_000

const repo: Repo = {
  id: 'orca',
  path: '/vercel/sandbox/project',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'orca::/vercel/orca/workspaces/project/fix-login',
  repoId: repo.id,
  hostId: `runtime:${ENVIRONMENT_ID}`,
  runtimeOwnerEnvironmentId: ENVIRONMENT_ID,
  instanceId: 'fix-login',
  path: '/vercel/orca/workspaces/project/fix-login',
  displayName: 'Fix login bug',
  branch: 'fix-login',
  head: 'abc123',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the row reads only id, name and source.
const environment = {
  id: ENVIRONMENT_ID,
  name: 'orca sandbox abcd1234',
  source: 'ephemeral-vm'
} as unknown as PublicKnownRuntimeEnvironment

type Credential = OrcaCloudAgentsStatus['credentials']['claude']

function accounts(claude: Credential, codex: Credential): OrcaCloudAgentAccountsState {
  return {
    load: {
      kind: 'ready',
      status: {
        credentials: { claude, codex, providerEnabled: { claude: true, codex: true } },
        sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
      }
    },
    setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 }
  }
}

function row(agentType: AgentType, prompt: string | null): DashboardAgentRow {
  const paneKey = `cloud-${agentType}:11111111-1111-4111-8111-111111111111`
  return {
    paneKey,
    tab: makeTabWithIds(`cloud-${agentType}`, worktree.id, prompt ?? ''),
    agentType,
    state: 'done',
    startedAt: now - 2 * 60_000,
    entry: {
      paneKey,
      agentType,
      prompt: prompt ?? '',
      state: 'done',
      stateStartedAt: now - 2 * 60_000,
      updatedAt: now - 2 * 60_000,
      stateHistory: [],
      // No prompt yet: only SessionStart has reported, so no turn has finished.
      sessionBoundary: prompt === null
    }
  }
}

function cloudRowFixture(
  state: OrcaCloudAgentAccountsState,
  agent: DashboardAgentRow,
  variant: 'compact' | 'full' = 'compact'
) {
  return defineFixture({
    width: variant === 'full' ? 360 : 300,
    store: {
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      runtimeEnvironments: [environment]
    },
    setup: () => setOrcaCloudAgentAccountsStateForTest(state),
    render: () => (
      <div className="bg-sidebar p-2 text-sidebar-foreground">
        {variant === 'full' ? (
          <DashboardAgentRowView
            agent={agent}
            now={now}
            onActivate={() => {}}
            onDismiss={() => {}}
          />
        ) : (
          <CompactAgentRow agent={agent} now={now} onActivate={() => {}} />
        )}
      </div>
    )
  })
}

/** Cloud Claude started without an Orca-account sign-in: it sits at its login screen. */
export const claudeNeedsSignIn = cloudRowFixture(
  accounts({ state: 'none' }, { state: 'none' }),
  row('claude', null)
)

/** The Orca account's Claude sign-in expired and no key covers it. */
export const claudeSignInExpired = cloudRowFixture(
  accounts({ state: 'expired' }, { state: 'none' }),
  row('claude', null)
)

export const codexNeedsSignIn = cloudRowFixture(
  accounts({ state: 'active' }, { state: 'none' }),
  row('codex', null)
)

/** For comparison: a covered Claude idle after a finished turn keeps Done. */
export const claudeCoveredDone = cloudRowFixture(
  accounts({ state: 'active' }, { state: 'active' }),
  row('claude', 'Fix the login redirect')
)

// The dashboard's full row reads the same sign-in state.
export const fullClaudeNeedsSignIn = cloudRowFixture(
  accounts({ state: 'none' }, { state: 'none' }),
  row('claude', null),
  'full'
)

export const fullClaudeSignInExpired = cloudRowFixture(
  accounts({ state: 'expired' }, { state: 'none' }),
  row('claude', null),
  'full'
)

export const fullCodexNeedsSignIn = cloudRowFixture(
  accounts({ state: 'active' }, { state: 'none' }),
  row('codex', null),
  'full'
)

export const fullClaudeCoveredDone = cloudRowFixture(
  accounts({ state: 'active' }, { state: 'active' }),
  row('claude', 'Fix the login redirect'),
  'full'
)

/** Keyboard focus on the status text opens the app tooltip that names the fix. */
function focusStatusText(frame: HTMLElement): void {
  frame.querySelectorAll<HTMLButtonElement>('[data-cloud-sign-in-status]')[1]?.focus()
}

export const claudeNeedsSignInTooltip = defineFixture({
  ...cloudRowFixture(accounts({ state: 'none' }, { state: 'none' }), row('claude', null)),
  width: 360,
  interact: focusStatusText
})

export const fullClaudeSignInExpiredTooltip = defineFixture({
  ...cloudRowFixture(
    accounts({ state: 'expired' }, { state: 'none' }),
    row('claude', null),
    'full'
  ),
  interact: focusStatusText
})

/** After a restart the pane can fall back to its title-derived row ("Claude Code - Idle"). */
function titleDerivedRow(): DashboardAgentRow {
  const base = row('claude', null)
  return {
    ...base,
    state: 'idle',
    startedAt: 0,
    entry: {
      ...base.entry,
      state: 'working',
      prompt: 'Claude Code',
      lastAssistantMessage: 'Idle',
      stateStartedAt: now,
      updatedAt: now
    }
  }
}

/** Revoked account, title-derived row after a restart: still "Sign-in expired - Claude". */
export const claudeRevokedAfterRestart = cloudRowFixture(
  accounts({ state: 'revoked' }, { state: 'none' }),
  titleDerivedRow()
)

export const fullClaudeRevokedAfterRestart = cloudRowFixture(
  accounts({ state: 'revoked' }, { state: 'none' }),
  titleDerivedRow(),
  'full'
)
