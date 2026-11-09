import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import { VmBuildAgentSignInRowView, type VmBuildAgentSignInRowModel } from './VmBuildAgentSignInRow'
import type { AgentSignInGate } from '@/lib/agent-sign-in/agent-sign-in-gate'
import {
  CLOUD_LOG,
  CLOUD_RECIPE,
  entry,
  FAILED_LOG,
  LOG,
  frame,
  LOG_LINES,
  NOW,
  sheet,
  stampsFor,
  T0
} from './vm-build-sheet-fixture-support'

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

export const provisionFailed = frame(
  entry({ status: 'error', provisioningLog: FAILED_LOG, errorAt: T0 + 98_000 }),
  'Recipe exited with code 1.'
)

// Orca Cloud

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

export const cloudCreateFailed = frame(
  entry(
    {
      status: 'error',
      errorAt: T0 + 8_900,
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
