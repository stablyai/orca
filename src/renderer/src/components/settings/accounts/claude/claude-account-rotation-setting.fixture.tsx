import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import {
  CLAUDE_ACCOUNT_ROTATION_DEFAULTS,
  type ClaudeAccountRotationFolder,
  type ClaudeAccountRotationStatus
} from '../../../../../../shared/agent-accounts/claude/claude-account-rotation'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { ClaudeAccountRotationSetting } from './claude-account-rotation-setting'

const SWITCHED_AT = Date.UTC(2026, 10, 27, 1, 40)

const folders: ClaudeAccountRotationFolder[] = [
  {
    accountId: 'work',
    claudeAccount: '4b4aac33',
    label: 'Work',
    selected: true,
    sessions: 3,
    login: 'active',
    usage: { fiveHourPercent: 12, weeklyPercent: 61, weeklyResetsAt: null, checkedAt: SWITCHED_AT }
  },
  {
    accountId: 'dev',
    claudeAccount: '803d0c1f',
    label: 'Dev',
    selected: false,
    sessions: 0,
    login: 'resting',
    usage: { fiveHourPercent: 4, weeklyPercent: 22, weeklyResetsAt: null, checkedAt: SWITCHED_AT }
  },
  {
    accountId: 'side',
    claudeAccount: '1c9e77d0',
    label: 'Side project',
    selected: false,
    sessions: 1,
    login: 'active',
    usage: { fiveHourPercent: 97, weeklyPercent: 88, weeklyResetsAt: null, checkedAt: SWITCHED_AT }
  }
]

const rotation = {
  ...CLAUDE_ACCOUNT_ROTATION_DEFAULTS,
  enabled: true,
  preferredAccounts: ['4b4aac33', '803d0c1f'],
  accounts: {
    '803d0c1f': { enabled: true, fiveHourPercent: 80, weeklyPercent: null },
    '1c9e77d0': { enabled: false, fiveHourPercent: null, weeklyPercent: null }
  }
}

const status: ClaudeAccountRotationStatus = {
  supported: true,
  enabled: true,
  pause: null,
  externalRotatorActive: false,
  settings: rotation,
  folders,
  lastSwitch: {
    at: SWITCHED_AT,
    accountId: 'work',
    fromClaudeAccount: '1c9e77d0',
    toClaudeAccount: '4b4aac33',
    fromLabel: 'Side project',
    toLabel: 'Work',
    kind: 'over',
    limits: [{ window: 'five-hour', percent: 97 }]
  },
  nextCandidateAccountId: 'dev',
  lastNote: 'ok',
  lastCheckedAt: SWITCHED_AT + 120_000,
  pendingSwitch: false,
  switchNeedsRepair: false
}

function stubStatus(next: ClaudeAccountRotationStatus): () => void {
  return () => {
    const accounts: unknown = window.api.claudeAccounts
    Reflect.set(window.api, 'claudeAccounts', {
      ...(typeof accounts === 'object' ? accounts : {}),
      rotationStatus: async () => next
    })
  }
}

function Setting({ on }: { on: boolean }): React.JSX.Element {
  const settings = {
    ...getDefaultSettings('/home/test'),
    claudeAccountRotation: on ? rotation : undefined
  }
  return (
    <SettingsGroup title="Claude">
      <ClaudeAccountRotationSetting settings={settings} updateSettings={() => {}} />
    </SettingsGroup>
  )
}

/** On, with a past switch, the account it would switch to next, and each account's own choices. */
export const enabled = defineFixture({
  width: 760,
  setup: stubStatus(status),
  render: () => <Setting on />
})

/** Off while ~/.claude/rotate is on: Orca stands down and says why. */
export const externalRotatorActive = defineFixture({
  width: 760,
  setup: stubStatus({
    ...status,
    enabled: false,
    pause: 'off',
    externalRotatorActive: true,
    settings: CLAUDE_ACCOUNT_ROTATION_DEFAULTS,
    lastSwitch: null
  }),
  render: () => <Setting on={false} />
})
