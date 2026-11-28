import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { nativeChatAppearanceStyle } from '../../../appearance/native-chat-appearance-style'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import { NativeChatWorkerDockFrame } from './NativeChatWorkerDockFrame'
import type { WorkerDockRowView } from './WorkerDockRow'
import { useWorkerDockFailureFocusHandoff, WorkerDockFailureStrip } from './WorkerDockFailureStrip'
import type { WorkerDockFailure } from './use-worker-dock-owner-actions'
import { useState, type ReactNode } from 'react'
import { NativeChatComposerField } from '../../../composer/editor/NativeChatComposerField'
import { FloatingTerminalToggleButton } from '../../../../floating-terminal/trigger/FloatingTerminalToggleButton'
import { FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY } from '../../../../floating-terminal/trigger/floating-terminal-trigger-position'

// A bot's Home Chat that started three workers with `orca orchestration worker-start`.
const SOURCE = '6c3f8e4a-ad5b-4a9c-9e37-2f4d8a0b3c59'
const minutes = (count: number) => Date.now() - count * 60_000

function worker(
  index: number,
  name: string,
  title: string,
  state: WorkerDockRowView['state'],
  startedMinutesAgo: number,
  extra: Partial<WorkerDockRowView> = {}
): WorkerDockRowView {
  return {
    kind: 'worker',
    id: `dock:${index}`,
    dispatchId: `ctx_bot_${index}`,
    source: SOURCE,
    name,
    title,
    model: 'gpt-6.1-sol',
    state,
    changedAt: minutes(startedMinutesAgo),
    startedAt: minutes(startedMinutesAgo),
    reason: null,
    settlement: null,
    resultId: null,
    stoppable: state !== 'needs-you',
    ownerActionsAvailable: true,
    ...extra
  }
}

const ask = worker(3, 'ORCA-20', 'Migrate the orders schema', 'needs-you', 6, {
  changedAt: minutes(1),
  question: 'Approve: run the migration against the staging copy of the orders database?'
})
const failed = worker(4, 'ORCA-21', 'Split the dock read model', 'failed', 8, {
  changedAt: minutes(3),
  reason: 'Typecheck failed: 3 errors in worker-dock-read.ts',
  settlement: 'settled:ctx_bot_4',
  resultId: 'result:ctx_bot_4'
})
const rows = [
  worker(1, 'ORCA-18', 'Fix streaming journal amplification', 'running', 12),
  worker(2, 'ORCA-19', 'Fix repeated worktree catalog scans', 'running', 9),
  ask,
  failed
]
function dock(expanded: boolean, list: readonly WorkerDockRowView[]) {
  const workerRows = new Map(list.map((row) => [row.id, row]))
  const workerIdentities = list.map(
    ({ id, state, changedAt, settlement, ownerActionsAvailable }) => ({
      id,
      state,
      changedAt,
      settlement,
      ownerActionsAvailable
    })
  )
  return (
    <NativeChatWorkerDockFrame>
      <NativeChatBackgroundTasksStatus
        sessionId={SOURCE}
        tasks={[]}
        settledTasks={[]}
        supportsTaskStop
        offersStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        indicatorActive
        isVisible
        expanded={expanded}
        onExpandedChange={() => {}}
        onStop={() => {}}
        workerRows={workerRows}
        workerIdentities={workerIdentities}
        onWorkerAction={noop}
      />
    </NativeChatWorkerDockFrame>
  )
}

const noop = () => {}
const ime = { isComposing: () => false, ownsKeyDown: () => false, reset: noop, setComposing: noop }

// The real message box and floating panel button in a full-height chat pane; the shot's window
// width decides where the button lands, so capture it with the viewport set to the fixture width.
function composerChat(expanded: boolean, footer?: ReactNode) {
  return (
    <div
      data-native-chat-root=""
      className="native-chat-appearance flex h-[calc(100vh-2rem)] flex-col bg-chat-canvas"
      style={nativeChatAppearanceStyle({})}
    >
      <div className="min-h-0 flex-1 space-y-2 p-3">
        <p className="text-xs text-muted-foreground">Perf Issue · Home Chat</p>
        <p className="text-sm text-chat-foreground">
          Both fix workers are running in parallel; ORCA-20 needs your approval.
        </p>
      </div>
      <NativeChatComposerField
        dock={
          <>
            {dock(expanded, rows)}
            {footer}
          </>
        }
        draftScopeKey="fixture:worker-dock-composer"
        textareaRef={{ current: null }}
        draft="Ship both fixes once ORCA-20 is approved"
        disabled={false}
        hasPty
        canSend
        autocomplete={{ mode: 'none' }}
        mentionFiles={{ files: [], loading: false, failed: false }}
        activeSuggestion={0}
        notices={[]}
        imageAttachments={[]}
        sendButtonDisabled={false}
        isWorking={false}
        hasDraft
        attachDisabled={false}
        dictationDisabled={false}
        isDictating={false}
        isDictationHoldMode={false}
        imeEnterGesture={ime}
        onDraftChange={noop}
        onTextareaSelect={noop}
        onKeyDown={noop}
        onImeSettled={noop}
        onPaste={noop}
        pickerListboxId="fixture-worker-dock-picker"
        onChoosePickerItem={noop}
        onRetrySkills={noop}
        onChooseMentionFile={noop}
        onRemoveImageAttachment={noop}
        onAttach={noop}
        onDictationToggle={noop}
        onDictationHoldStart={noop}
        onDictationHoldEnd={noop}
        onSend={noop}
        sessionOptionsSurface={null}
        sessionOptionsSnapshot={[]}
      />
      <FloatingTerminalToggleButton open={false} onToggle={noop} />
    </div>
  )
}

// A position the user dragged the button to, right over Send at the box's bottom right.
function savePositionOverSend() {
  localStorage.setItem(
    FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY,
    JSON.stringify({ anchorX: 'right', anchorY: 'bottom', offsetX: 18, offsetY: 22 })
  )
}
function forgetSavedPosition() {
  localStorage.removeItem(FLOATING_TERMINAL_TRIGGER_POSITION_STORAGE_KEY)
}

export const composerDefault390 = defineFixture({
  width: 390,
  setup: forgetSavedPosition,
  render: () => composerChat(true)
})

export const composerOverSend390 = defineFixture({
  width: 390,
  setup: savePositionOverSend,
  render: () => composerChat(true)
})

export const composerDefault320 = defineFixture({
  width: 320,
  setup: forgetSavedPosition,
  render: () => composerChat(true)
})

export const composerOverSend320 = defineFixture({
  width: 320,
  setup: savePositionOverSend,
  render: () => composerChat(false)
})

// Keyboard focus on the first row's Stop, at the roster's clipped edge.
async function focusFirstStop(frame: HTMLElement) {
  const stop = frame.querySelector<HTMLElement>('[data-worker-dock-action="dock:1"]')
  if (!stop) {
    throw new Error('Stop button not found')
  }
  // Chromium's focusVisible option draws the keyboard ring for a scripted focus.
  stop.focus({ focusVisible: true })
  await new Promise((resolve) => setTimeout(resolve, 100))
}

export const stopFocused360 = defineFixture({
  width: 360,
  render: () => composerChat(true),
  interact: focusFirstStop
})

// A Retry pressed after the worker settled: nothing is sent, the line says why, and no Retry is
// left to press.
export const retryAfterSettle360 = defineFixture({
  width: 360,
  render: () =>
    composerChat(
      true,
      <WorkerDockFailureStrip failure={{ message: 'Already stopped' }} onDismiss={noop} />
    )
})

// The real hand-off: Retry is focused and pressed, the line clears, then returns as final.
function RetryThenSettled() {
  const handoff = useWorkerDockFailureFocusHandoff()
  const [failure, setFailure] = useState<WorkerDockFailure | null>(() => ({
    message: 'Connection dropped',
    retry: () => {
      setFailure(null)
      queueMicrotask(() => setFailure({ message: 'Already stopped' }))
    }
  }))
  return failure ? (
    <WorkerDockFailureStrip
      key={`${failure.message}\0${failure.retry ? 'retry' : 'final'}`}
      failure={failure}
      onDismiss={() => setFailure(null)}
      focusHandoff={handoff}
    />
  ) : null
}

async function pressFocusedRetry(frame: HTMLElement) {
  const retry = [...frame.querySelectorAll<HTMLElement>('[role="alert"] button')].find(
    (button) => button.textContent === 'Retry'
  )
  if (!retry) {
    throw new Error('Retry button not found')
  }
  retry.focus({ focusVisible: true })
  retry.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
}

export const retryFocusAfterSettle360 = defineFixture({
  width: 360,
  render: () => composerChat(true, <RetryThenSettled />),
  interact: pressFocusedRetry
})
