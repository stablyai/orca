import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { VmBuildSheet } from './VmBuildSheet'
import { VmBuildAgentSignInRowView, type VmBuildAgentSignInRowModel } from './VmBuildAgentSignInRow'
import type { AgentSignInGate } from '@/lib/agent-sign-in/agent-sign-in-gate'
import { formatElapsedTime } from './worktree-creation-clock'

const LOG_LINES = [
  'Creating sandbox from snapshot snap_7f2c…',
  'Sandbox ready: sbx_41d9 (us-east-1)',
  'Cloning repository…',
  'Starting orca serve on :7420',
  'Pairing code emitted.'
]
const LOG = LOG_LINES.join('\n')
// Every fixture is drawn 102 seconds into its build, with lines arriving a second or so apart.
const T0 = 1_700_000_000_000
const NOW = T0 + 102_000
const stampsFor = (lines: number): number[] =>
  Array.from({ length: lines }, (_, index) => T0 + 400 + index * 1300)

type Recipe = NonNullable<PendingWorktreeCreation['request']['ephemeralVmRecipe']>
const LOCAL_RECIPE: Recipe = { sourceRepoId: 'repo', recipeId: 'sandbox', projectId: 'p' }
const CLOUD_RECIPE: Recipe = { ...LOCAL_RECIPE, recipeId: 'cloud', provider: 'orca-cloud' }

function entry(
  patch: Partial<PendingWorktreeCreation>,
  recipe: Recipe = LOCAL_RECIPE
): PendingWorktreeCreation {
  const log = patch.provisioningLog ?? LOG
  return {
    creationId: 'fixture',
    phase: 'provisioning-vm',
    status: 'creating',
    startedAt: T0,
    indeterminate: false,
    loaderVisible: true,
    provisioningLog: log,
    provisioningLogStamps: stampsFor(log === '' ? 0 : log.split('\n').length),
    phaseLog: [{ phase: 'provisioning-vm', at: T0 }],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only name and ephemeralVmRecipe from the request.
    request: { name: 'fix-login', ephemeralVmRecipe: recipe } as PendingWorktreeCreation['request'],
    ...patch
  }
}

function sheet(
  value: PendingWorktreeCreation,
  error: string | null,
  now: number,
  agentSignInRow?: React.ReactNode
) {
  return (
    <div className="bg-background p-3">
      <VmBuildSheet
        creationId="fixture"
        entry={value}
        now={now}
        elapsedLabel={formatElapsedTime(now - value.startedAt)}
        error={error}
        onCancel={() => {}}
        onRetry={() => {}}
        onDismiss={() => {}}
        onEditRecipe={() => {}}
        agentSignInRow={agentSignInRow}
      />
    </div>
  )
}

function frame(
  value: PendingWorktreeCreation,
  error: string | null = null,
  now = NOW,
  agentSignInRow?: React.ReactNode
) {
  return defineFixture({ width: 760, render: () => sheet(value, error, now, agentSignInRow) })
}
const noop = (): void => {}

function signInRow(model: VmBuildAgentSignInRowModel): React.ReactNode {
  return (
    <VmBuildAgentSignInRowView
      model={model}
      gateKey="fixture"
      actions={{ signIn: noop, cancel: noop, switchAccount: noop }}
    />
  )
}

function vmGate(agent: AgentSignInGate['agent'], view: AgentSignInGate['view']): AgentSignInGate {
  return {
    key: 'fixture',
    environmentId: 'env-vm',
    hostLabel: 'fix-login',
    agent,
    prompt: null,
    codeOnly: false,
    view
  }
}

const checkingVm = entry({
  environmentCheck: { status: 'running' },
  provisioningLog: ['Cloning repository…', 'Starting orca serve on :7420', 'Paired.'].join('\n')
})

export const signInIdle = frame(
  checkingVm,
  null,
  NOW,
  signInRow({ kind: 'idle', agents: ['claude', 'codex'] })
)

export const signInWaiting = frame(
  checkingVm,
  null,
  NOW,
  signInRow({
    kind: 'busy',
    agent: 'claude',
    next: ['codex'],
    gate: vmGate('claude', { step: 'waiting', url: 'https://claude.ai/oauth/authorize' })
  })
)

export const signInDeviceCode = frame(
  checkingVm,
  null,
  NOW,
  signInRow({
    kind: 'busy',
    agent: 'codex',
    next: [],
    gate: vmGate('codex', {
      step: 'device',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'K7PQ-2HXM'
    })
  })
)

export const signInDone = frame(
  checkingVm,
  null,
  NOW,
  signInRow({
    kind: 'done',
    agents: [
      { agent: 'claude', email: 'nw@stably.ai' },
      { agent: 'codex', email: 'nw@stably.ai' }
    ]
  })
)

export const signInOtherAccount = frame(
  checkingVm,
  null,
  NOW,
  signInRow({
    kind: 'done',
    agents: [
      { agent: 'claude', email: 'nw@stably.ai' },
      { agent: 'codex', email: 'nw@personal.dev', expectedEmail: 'nw@stably.ai' }
    ]
  })
)

// Local recipe VM

export const provisioning = frame(entry({ provisioningLog: LOG_LINES.slice(0, 2).join('\n') }))

export const checking = frame(
  entry({ environmentCheck: { status: 'running', startedAt: T0 + 96_000 } })
)

const FAILED_CHECKS: NonNullable<PendingWorktreeCreation['environmentCheck']>['checks'] = [
  { id: 'tool.git', category: 'tools', status: 'pass', message: 'git is installed.' },
  {
    id: 'tool.pnpm',
    category: 'tools',
    status: 'fail',
    message: 'pnpm is not on PATH, but package.json needs it.',
    remediation: 'Install pnpm in the environment image or setup script.',
    code: 'toolMissing',
    params: { command: 'pnpm', reason: 'package.json' }
  },
  {
    id: 'agent.claude',
    category: 'agents',
    status: 'warn',
    message: 'Claude is installed but not signed in.',
    remediation: 'Run `claude auth login` in this environment.',
    code: 'agentSignedOut',
    params: { agent: 'Claude' }
  },
  {
    id: 'git.push',
    category: 'git',
    status: 'fail',
    message: 'A dry-run push to "origin" was refused.',
    remediation:
      'Give this environment a Git credential with write access to the repo.\nremote: Permission to acme/web.git denied.'
  }
]

const CHECKS_FAILED_AT = { startedAt: T0 + 96_000, finishedAt: T0 + 99_000 }

export const checksFailed = frame(
  entry({ environmentCheck: { status: 'failed', checks: FAILED_CHECKS, ...CHECKS_FAILED_AT } })
)

const FAILED_LOG = `${LOG}\nError: snapshot snap_7f2c not found`

export const provisionFailed = frame(
  entry({ status: 'error', provisioningLog: FAILED_LOG }),
  'Recipe exited with code 1.'
)

// Orca Cloud

const CLOUD_LOG = '[orca-cloud] checking-entitlement\n[orca-cloud] provisioning'

export const cloudStarting = frame(
  entry({ provisioningLog: CLOUD_LOG }, CLOUD_RECIPE),
  null,
  T0 + 3_000
)

export const cloudPreparing = frame(
  entry(
    { environmentCheck: { status: 'running', startedAt: T0 + 4_800 }, provisioningLog: LOG },
    CLOUD_RECIPE
  ),
  null,
  T0 + 6_000
)

const CLOUD_OPENING_PHASES: PendingWorktreeCreation['phaseLog'] = [
  { phase: 'provisioning-vm', at: T0 },
  { phase: 'fetching', at: T0 + 7_600 },
  { phase: 'creating', at: T0 + 8_200 }
]
const CLOUD_CHECKS_PASSED = {
  status: 'passed',
  checks: [],
  startedAt: T0 + 4_800,
  finishedAt: T0 + 7_600
} as const

export const cloudOpening = frame(
  entry(
    {
      phase: 'creating',
      phaseLog: CLOUD_OPENING_PHASES,
      environmentCheck: CLOUD_CHECKS_PASSED,
      checkoutProgress: { percent: 64, completed: 1830, total: 2860 }
    },
    CLOUD_RECIPE
  ),
  null,
  T0 + 9_000
)

export const cloudReady = frame(
  entry(
    {
      phase: 'creating',
      phaseLog: CLOUD_OPENING_PHASES,
      environmentCheck: CLOUD_CHECKS_PASSED,
      worktreeId: 'repo::/workspace/fix-login'
    },
    CLOUD_RECIPE
  ),
  null,
  T0 + 9_400
)

function cloudFailure(errorCode: string | undefined, error: string, log = CLOUD_LOG) {
  return frame(
    entry({ status: 'error', errorCode, provisioningLog: log }, CLOUD_RECIPE),
    error,
    T0 + 2_000
  )
}

export const cloudPlanRequired = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours. Open Plan & billing to choose one.',
  ''
)

export const cloudConcurrencyLimit = cloudFailure(
  'cloudConcurrencyLimit',
  'You already have as many Orca Cloud workspaces running as your plan allows.',
  ''
)

export const cloudUnavailable = cloudFailure(
  'cloudUnavailable',
  'Orca Cloud is unavailable right now. Try again in a moment.',
  ''
)

export const cloudSignInRequired = cloudFailure(
  'cloudSignInRequired',
  'Sign in to Orca to use Orca Cloud workspaces.',
  ''
)

export const cloudSnapshotMissing = cloudFailure(
  'recipeExited',
  'Recipe exited with code 1.',
  FAILED_LOG
)

export const cloudFailed = cloudFailure(
  'recipeExited',
  'Recipe exited with code 1.',
  `${LOG}\nfatal: sandbox agent stopped unexpectedly`
)

export const cloudHoursUsed = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours.',
  `${CLOUD_LOG}\nOrca Cloud: included_hours_exhausted`
)

export const cloudPaymentDue = cloudFailure(
  'cloudPlanRequired',
  'Orca Cloud workspaces need a plan with cloud hours.',
  `${CLOUD_LOG}\nOrca Cloud: payment_past_due`
)

export const cloudNetwork = cloudFailure(undefined, 'fetch failed', CLOUD_LOG)

export const cloudCreateFailed = frame(
  entry(
    {
      status: 'error',
      phase: 'creating',
      phaseLog: CLOUD_OPENING_PHASES,
      environmentCheck: CLOUD_CHECKS_PASSED,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sheet reads only these request fields.
      request: {
        name: 'fix-login',
        ephemeralVmRecipe: CLOUD_RECIPE,
        ephemeralVmRuntimeId: 'runtime-1'
      } as PendingWorktreeCreation['request']
    },
    CLOUD_RECIPE
  ),
  'fatal: could not create work tree dir: Permission denied',
  T0 + 9_000
)

export const checksSkipped = frame(
  entry({
    phase: 'fetching',
    phaseLog: [
      { phase: 'provisioning-vm', at: T0 },
      { phase: 'fetching', at: T0 + 98_000 }
    ],
    environmentCheck: { status: 'skipped', startedAt: T0 + 98_000, finishedAt: T0 + 98_000 }
  })
)

export const cloudChecksFailed = frame(
  entry(
    { environmentCheck: { status: 'failed', checks: FAILED_CHECKS, ...CHECKS_FAILED_AT } },
    CLOUD_RECIPE
  )
)

// A build replayed on a timer, for recording the transitions: log streams, checks run and fail,
// the card opens, Retry collapses it, and a second pass succeeds.
const TIMELINE: { at: number; patch: Partial<PendingWorktreeCreation> }[] = [
  { at: 0, patch: { provisioningLog: '', provisioningLogStamps: [] } },
  ...LOG_LINES.map((_, index) => ({
    at: 500 + index * 450,
    patch: {
      provisioningLog: LOG_LINES.slice(0, index + 1).join('\n'),
      provisioningLogStamps: stampsFor(index + 1)
    }
  })),
  { at: 3000, patch: { environmentCheck: { status: 'running', startedAt: T0 + 3000 } } },
  {
    at: 4600,
    patch: {
      environmentCheck: {
        status: 'failed',
        checks: FAILED_CHECKS,
        startedAt: T0 + 3000,
        finishedAt: T0 + 4600
      }
    }
  },
  { at: 8200, patch: { environmentCheck: { status: 'running', startedAt: T0 + 8200 } } },
  {
    at: 9800,
    patch: {
      environmentCheck: {
        status: 'passed',
        checks: [],
        startedAt: T0 + 8200,
        finishedAt: T0 + 9800
      },
      phase: 'fetching',
      phaseLog: [
        { phase: 'provisioning-vm', at: T0 },
        { phase: 'fetching', at: T0 + 9800 }
      ]
    }
  }
]

function LiveBuild(): React.JSX.Element {
  const [value, setValue] = React.useState(() => entry({ provisioningLog: '' }))
  const [now, setNow] = React.useState(T0)
  React.useEffect(() => {
    const timers = TIMELINE.map(({ at, patch }) =>
      window.setTimeout(() => {
        setValue((current) => ({ ...current, ...patch }))
        setNow(T0 + at)
      }, at)
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [])
  return sheet(value, null, now)
}

export const live = defineFixture({ width: 760, render: () => <LiveBuild /> })
