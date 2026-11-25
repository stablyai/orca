import { useState } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY } from '../../../../../shared/automations/automation-runtime-capabilities'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { automationRunModelUnavailable } from '../../../../../shared/automations/history/automation-run-model-failure'
import type { Bot } from '../../../../../shared/bot-types'
import { makeAutomation, makeRun } from '../automations-page-fixtures'
import { AutomationEditorDialog } from '../authoring/AutomationEditorDialog'
import { buildAutomationEditDraft } from '../authoring/automation-edit-draft'
import { AutomationRunDetailsPage } from './AutomationRunDetailsPage'
import { AutomationRunModelSelect, type AutomationRunModelPicker } from './AutomationRunModelPicker'
import { showAutomationModelRecoveryResult } from './automation-run-model-fix'
import type { SelectedAutomationRunHistoryOutcome } from './use-selected-automation-run-history'

const NOW = Date.UTC(2026, 10, 20, 19, 0)
const HOUR = 60 * 60 * 1000
const noop = (): void => {}

const fixtureTarget = { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' } as const
const botAutomation = makeAutomation({
  id: 'a-2',
  name: 'Weekly digest',
  prompt: 'Summarize this week’s sample notes.',
  agentId: 'codex',
  bot: fixtureTarget
})
const fixtureBot: Bot = {
  id: 'bot-1',
  name: 'Digest Owl',
  agent: 'codex',
  launch: { model: 'model-alpha-preview-long-name' },
  hostId: 'local',
  folder: 'digest-owl',
  folderWorkspaceId: 'digest-folder',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const remoteFixtureBot = stampBotHost('runtime:sample-runtime', fixtureBot)
const MODELS = [
  { id: 'model-alpha-preview-long-name', label: 'model-alpha-preview-long-name' },
  { id: 'model-beta', label: 'Model Beta' },
  { id: 'model-gamma', label: 'Model Gamma' }
]
const at = NOW - 3 * HOUR
const failedAt = { scheduledFor: at, startedAt: at, dispatchedAt: at, createdAt: at }
const scenarios: Record<string, AutomationRun> = {
  modelFailed: makeRun({
    id: 'run-7',
    automationId: 'a-2',
    runNumber: 7,
    status: 'dispatch_failed',
    sessionKind: 'chat',
    error: "Codex couldn't use model-alpha-preview-long-name.",
    errorCode: 'agentModelUnavailable',
    errorParams: { agent: 'codex', model: 'model-alpha-preview-long-name' },
    ...failedAt
  }),
  otherFailed: makeRun({
    id: 'run-7',
    automationId: 'a-2',
    runNumber: 7,
    status: 'dispatch_failed',
    sessionKind: 'chat',
    error: 'API Error: 503 Service unavailable',
    ...failedAt
  }),
  completed: makeRun({
    id: 'run-7',
    automationId: 'a-2',
    runNumber: 7,
    status: 'completed',
    sessionKind: 'chat',
    outputSnapshot: {
      format: 'plain_text',
      content: 'Three pull requests merged this week.',
      capturedAt: at,
      truncated: false
    },
    ...failedAt
  }),
  // After picking Model Beta: the new run, started from the saved automation.
  afterPick: makeRun({
    id: 'run-8',
    automationId: 'a-2',
    runNumber: 8,
    status: 'dispatched',
    trigger: 'manual',
    sessionKind: 'chat',
    scheduledFor: NOW,
    startedAt: NOW,
    dispatchedAt: NOW,
    createdAt: NOW
  })
}

function fixedPicker(open: boolean, options = MODELS): typeof AutomationRunModelPicker {
  return function FixedPicker({ currentModel, failureParams, disabled, onPick, renderNotice }) {
    return renderNotice(
      options.length ? (
        <AutomationRunModelSelect
          options={options}
          currentModel={currentModel}
          failureParams={failureParams}
          disabled={disabled}
          defaultOpen={open}
          onPick={onPick}
        />
      ) : undefined
    )
  }
}

const closedPicker = fixedPicker(false)
const openPicker = fixedPicker(true)
const emptyPicker = fixedPicker(false, [])
const longPicker = fixedPicker(false, [
  ...MODELS,
  ...Array.from({ length: 20 }, (_, index) => ({
    id: `model-sample-${index + 1}`,
    label: `Model Sample ${index + 1}`
  }))
])

function RunRecovery({
  initialRun,
  open,
  remote,
  empty,
  initialModel,
  settingsModel,
  initialConfirmation,
  olderHost = false
}: {
  initialRun: AutomationRun
  open: boolean
  remote: boolean
  empty: boolean
  initialModel?: string
  settingsModel?: string
  initialConfirmation?: string
  olderHost?: boolean
}) {
  const [run, setRun] = useState(initialRun)
  const [model, setModel] = useState(initialModel ?? null)
  const [confirmedModel, setConfirmedModel] = useState(initialConfirmation ?? null)
  const runs = confirmedModel ? [scenarios.afterPick, initialRun] : [run]
  const automation = model
    ? {
        ...botAutomation,
        bot: { ...fixtureTarget, agentSetup: { agent: fixtureBot.agent, launch: { model } } }
      }
    : botAutomation
  const [draft, setDraft] = useState(() => buildAutomationEditDraft(botAutomation))
  const [editorOpen, setEditorOpen] = useState(false)
  const [workspaceOpened, setWorkspaceOpened] = useState(false)
  const bot = remote || olderHost ? remoteFixtureBot : fixtureBot
  const hostLabel = olderHost ? 'Atlas' : remote ? 'Sample server' : 'This computer'
  const history: SelectedAutomationRunHistoryOutcome = {
    automationId: botAutomation.id,
    rowKey: null,
    ownerKey: null,
    authority: null,
    navigation: null,
    reloadToken: 0,
    runs,
    notice: null
  }
  return (
    <div className="bg-background text-foreground" style={{ minHeight: open ? 320 : undefined }}>
      <AutomationRunDetailsPage
        nav={null}
        automation={automation}
        run={run}
        runs={runs}
        history={history}
        relativeNow={NOW}
        hostLabel={hostLabel}
        workspaceName="Sample workspace"
        workspaceActionLabel="Open workspace"
        canRerun
        isRerunPending={false}
        onRerun={() => setRun(scenarios.afterPick)}
        bot={settingsModel ? { ...bot, launch: undefined } : bot}
        defaultModel={settingsModel}
        modelConfirmation={
          confirmedModel && run.id === initialRun.id ? { model: confirmedModel } : null
        }
        onEdit={() => {
          setDraft(buildAutomationEditDraft(automation))
          setEditorOpen(true)
        }}
        onPickModel={async (option) => {
          if (olderHost) {
            showAutomationModelRecoveryResult({ status: 'unsupported' }, hostLabel)
            return
          }
          if (remote) {
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
          setModel(option.id)
          setConfirmedModel(option.label)
        }}
        modelPicker={empty ? emptyPicker : remote ? longPicker : open ? openPicker : closedPicker}
        onOpenWorkspace={() => setWorkspaceOpened(true)}
        onReviewSetup={noop}
        onSelectRun={setRun}
      />
      <Toaster duration={30_000} />
      {workspaceOpened ? <p role="status">Sample workspace opened</p> : null}
      {editorOpen ? (
        <AutomationEditorDialog
          open={editorOpen}
          isEditing
          isSaving={false}
          canSave
          repos={[]}
          projectHostSetups={[]}
          automationYamlHooksByRepoKey={{}}
          getAutomationHooksCacheKey={(repoId) => repoId}
          repoMap={new Map()}
          worktrees={[]}
          settings={null}
          draft={draft}
          bots={[bot]}
          onProjectChange={noop}
          onOpenChange={setEditorOpen}
          onDraftChange={setDraft}
          onSetupDecisionTouched={noop}
          onApplyTemplate={noop}
          onSave={() => setEditorOpen(false)}
        />
      ) : null}
    </div>
  )
}

function renderBotRun(run: AutomationRun, open = false, remote = false, empty = false) {
  return <RunRecovery initialRun={run} open={open} remote={remote} empty={empty} />
}

export const modelFailed360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.modelFailed)
})
export const modelFailed520 = defineFixture({
  width: 520,
  render: () => renderBotRun(scenarios.modelFailed)
})
export const modelFailed720 = defineFixture({
  width: 720,
  render: () => renderBotRun(scenarios.modelFailed)
})
export const otherFailed360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.otherFailed)
})
export const otherFailed520 = defineFixture({
  width: 520,
  render: () => renderBotRun(scenarios.otherFailed)
})
export const otherFailed720 = defineFixture({
  width: 720,
  render: () => renderBotRun(scenarios.otherFailed)
})
export const completed360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.completed)
})
export const completed520 = defineFixture({
  width: 520,
  render: () => renderBotRun(scenarios.completed)
})
export const completed720 = defineFixture({
  width: 720,
  render: () => renderBotRun(scenarios.completed)
})
export const pickerOpen360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.modelFailed, true)
})
export const pickerOpen520 = defineFixture({
  width: 520,
  render: () => renderBotRun(scenarios.modelFailed, true)
})
export const pickerOpen720 = defineFixture({
  width: 720,
  render: () => renderBotRun(scenarios.modelFailed, true)
})
function renderAfterPick() {
  return (
    <RunRecovery
      initialRun={scenarios.modelFailed}
      initialModel="model-beta"
      initialConfirmation="Model Beta"
      open={false}
      remote={false}
      empty={false}
    />
  )
}

export const afterPick360 = defineFixture({
  width: 360,
  render: renderAfterPick
})
export const afterPick520 = defineFixture({
  width: 520,
  render: renderAfterPick
})
export const afterPick720 = defineFixture({
  width: 720,
  render: renderAfterPick
})
export const remoteModelFailed360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.modelFailed, false, true)
})
export const noCatalog360 = defineFixture({
  width: 360,
  render: () => renderBotRun(scenarios.modelFailed, false, false, true)
})

function renderCurrentDiffers(failedModel: string | undefined) {
  return (
    <RunRecovery
      initialRun={{
        ...scenarios.modelFailed,
        ...automationRunModelUnavailable({
          agent: 'codex',
          agentLabel: 'Codex',
          model: failedModel,
          launchModel: failedModel
        })
      }}
      settingsModel="model-beta"
      open={false}
      remote={false}
      empty={false}
    />
  )
}

export const currentModelDiffers360 = defineFixture({
  width: 360,
  render: () => renderCurrentDiffers(fixtureBot.launch?.model)
})

// A 120-character failed model with a long unbroken run must wrap instead of pushing the picker out.
const LONG_FAILED_MODEL = 'sample-preview-'.padEnd(120, 'x')
const renderCurrentDiffersLongName = () => renderCurrentDiffers(LONG_FAILED_MODEL)

export const currentModelDiffersLongName360 = defineFixture({
  width: 360,
  render: renderCurrentDiffersLongName
})
export const currentModelDiffersLongName520 = defineFixture({
  width: 520,
  render: renderCurrentDiffersLongName
})
export const currentModelDiffersLongName720 = defineFixture({
  width: 720,
  render: renderCurrentDiffersLongName
})

export const aliasFailure360 = defineFixture({
  width: 360,
  render: () => (
    <RunRecovery
      initialRun={scenarios.modelFailed}
      initialModel="model-beta"
      open={false}
      remote={false}
      empty={false}
    />
  )
})

export const olderHost360 = defineFixture({
  width: 360,
  setup: () => clearRuntimeCompatibilityCache('sample-runtime'),
  render: () => (
    <RunRecovery
      initialRun={scenarios.modelFailed}
      olderHost
      open={false}
      remote={false}
      empty={false}
    />
  )
})

export const knownOlderHost360 = defineFixture({
  ...olderHost360,
  setup: () =>
    markRuntimeEnvironmentCompatible('sample-runtime', {
      ...createCompatibleRuntimeStatusResponse('sample-runtime').result,
      capabilities: [AUTOMATION_OWNER_FENCING_RUNTIME_CAPABILITY]
    })
})
