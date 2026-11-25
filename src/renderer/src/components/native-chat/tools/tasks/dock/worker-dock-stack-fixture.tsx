import { useRef } from 'react'
import { NativeChatThreadGoalBanner } from '../../../session/goals/NativeChatThreadGoalBanner'
import { NativeChatFindBar } from '../../../viewport/find/NativeChatFindBar'
import { NativeChatBackgroundTasksStatus } from '../NativeChatBackgroundTasksStatus'
import type { WorkerDockRowView } from './WorkerDockRow'
import { NativeChatComposerField } from '../../../composer/editor/NativeChatComposerField'

// Dev-only: the worker tray, goal banner and find bar the dock stack fixtures share.
const SOURCE = 'fixture-stack'
const minutes = (count: number) => Date.now() - count * 60_000
const titles = [
  'GitHub sidebar feedback research across the open issues and the last two releases',
  'Fix app rail spacing',
  'Review PR #47379 and summarize what still blocks it'
]
export const running: WorkerDockRowView[] = titles.map((title, index) => ({
  kind: 'worker',
  id: `stack:${index}`,
  dispatchId: `ctx_stack_${index}`,
  source: SOURCE,
  name: 'claude',
  title,
  model: ['gpt-6.1-terra', 'claude-opus-5-5', 'gpt-6-astra'][index],
  state: 'running',
  changedAt: minutes(3 + index * 2),
  startedAt: minutes(3 + index * 2),
  reason: null,
  settlement: null,
  resultId: null,
  stoppable: true,
  ownerActionsAvailable: true
}))

const fail = (row: WorkerDockRowView, index: number): WorkerDockRowView => ({
  ...row,
  id: `stack:failed:${index}`,
  dispatchId: `ctx_stack_failed_${index}`,
  state: 'failed',
  reason: 'Typecheck failed',
  settlement: `settled:${index}`,
  resultId: `result:${index}`,
  stoppable: false
})
export const failedOnly = running.slice(0, 2).map(fail)
export const mixed = [...running, ...failedOnly]
export const many = Array.from({ length: 20 }, (_, index) => {
  const row = { ...running[index % 3], id: `stack:${index}`, dispatchId: `ctx_stack_${index}` }
  return index < 3 ? fail(row, index) : row
})

export function Tray({ open, rows }: { open: boolean; rows: readonly WorkerDockRowView[] }) {
  return (
    <NativeChatBackgroundTasksStatus
      sessionId={SOURCE}
      tasks={[]}
      settledTasks={[]}
      supportsTaskStop
      offersStopAll
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      indicatorActive
      isVisible
      expanded={open}
      onExpandedChange={() => {}}
      onStop={() => {}}
      workerRows={new Map(rows.map((row) => [row.id, row]))}
      workerIdentities={rows}
      onWorkerAction={() => {}}
    />
  )
}

export const goal = (
  <NativeChatThreadGoalBanner
    goal={{
      objective: 'Ship the worker tray redesign with screenshots on the PR',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 240,
      createdAt: 0,
      updatedAt: 0,
      checks: 0
    }}
    pending={false}
    hostChanges={false}
    sendUnavailable={false}
    isVisible={false}
    runningTurn={null}
    onChange={() => {}}
  />
)

export function FindBar() {
  const rootRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <NativeChatFindBar
      isVisible
      find={{
        isOpen: true,
        query: 'worker',
        setQuery: () => {},
        close: () => {},
        open: undefined,
        onKeyDownCapture: () => {},
        rootRef,
        barRef,
        inputRef,
        revealMatch: () => {}
      }}
    />
  )
}

const noop = () => {}
const ime = { isComposing: () => false, ownsKeyDown: () => false, reset: noop, setComposing: noop }

/** The real message box, so row edges are measured against what a chat draws. */
export function RealComposer() {
  return (
    <NativeChatComposerField
      draftScopeKey="fixture:dock-alignment"
      textareaRef={{ current: null }}
      draft=""
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
      hasDraft={false}
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
      pickerListboxId="fixture-dock-alignment-picker"
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
  )
}
