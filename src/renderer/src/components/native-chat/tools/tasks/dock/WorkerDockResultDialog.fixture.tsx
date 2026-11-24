import { useState } from 'react'
import { defineFixture } from '../../../../../component-fixtures/component-fixture'
import { WorkerDockResultDialog } from './WorkerDockResultDialog'
import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'

// Invented data: an audit worker named after its own prompt, stopped by a slow worktree.
const PROMPT =
  'You are a read-only audit worker for the billing release checklist. Change nothing, push no...'
const ERROR =
  'Creating the worktree took longer than 180 seconds, so Orca stopped Git. To allow more time, set ORCA_WORKTREE_ADD_TIMEOUT_MS (milliseconds, up to 1800000) in the environment that starts Orca on the machine running Git (the remote host for SSH or `orca serve` workspaces), then restart Orca there.'
// The worst case the card meets: one long first sentence, then a raw multi-line log.
const LONG_ERROR = `The worker could not start because Git refused to create the worktree at /workspace/billing/.worktrees/release-audit-checklist-and-follow-up-notes while another process held its index lock for longer than the allowed wait. ${Array.from(
  { length: 24 },
  (_, index) =>
    `\n[git] attempt ${index + 1}: fatal: Unable to create '/workspace/billing/.git/worktrees/release-audit/index.lock': File exists.`
).join('')}`
// Short, but wide glyphs fill two lines of a narrow card.
const WIDE_ERROR =
  'ワークツリーの作成が三分を超えたため、Gitを停止しました。環境変数を設定してからOrcaを再起動し、もう一度このワーカーを実行してください。'

const failed: WorkerDockResult = {
  id: 'result:0',
  dispatchId: 'ctx_card_0',
  name: PROMPT,
  title: PROMPT,
  outcome: 'unexpected',
  body: ERROR,
  at: Date.now() - 58 * 60_000,
  settlement: 'settled:0',
  acknowledged: false,
  ownerActionsAvailable: true,
  report: false
}

function Card({ result }: { result: WorkerDockResult }) {
  return (
    <div className="h-[420px] bg-background">
      <WorkerDockResultDialog
        result={result}
        error={null}
        onClose={() => {}}
        onOpen={() => {}}
        onRestore={() => {}}
        onReturnFocus={() => {}}
        ownerActionsAvailable
      />
    </div>
  )
}

/** A button that opens the card, so a real click and a real Enter can each open it. */
function Opener() {
  const [open, setOpen] = useState(false)
  return (
    <div className="h-[420px] bg-background p-4">
      <button
        type="button"
        data-fixture-opener=""
        className="rounded-md border border-border px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        Open the audit worker
      </button>
      {open ? (
        <WorkerDockResultDialog
          result={failed}
          error={null}
          onClose={() => setOpen(false)}
          onOpen={() => {}}
          onRestore={() => {}}
          onReturnFocus={() =>
            document.querySelector<HTMLElement>('[data-fixture-opener]')?.focus()
          }
          ownerActionsAvailable
        />
      ) : null}
    </div>
  )
}

async function expandDetails() {
  document.querySelector<HTMLButtonElement>('[data-worker-dock-details]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 100))
}

export const cardFailed = defineFixture({ width: 720, render: () => <Card result={failed} /> })

export const cardFailedDetails = defineFixture({
  width: 720,
  render: () => <Card result={failed} />,
  interact: expandDetails
})

export const cardWorstCase = defineFixture({
  width: 720,
  render: () => <Card result={{ ...failed, body: LONG_ERROR }} />,
  interact: expandDetails
})

export const cardShortWideError = defineFixture({
  width: 720,
  render: () => <Card result={{ ...failed, body: WIDE_ERROR }} />
})

export const cardFinished = defineFixture({
  width: 720,
  render: () => (
    <Card
      result={{
        ...failed,
        name: 'Release notes',
        title: 'Draft release notes for the payments dashboard from the merged changes this week',
        outcome: 'succeeded',
        body: '**Done.** Drafted notes for 12 merged changes, grouped into Fixes and Improvements.'
      }}
    />
  )
})

export const cardOpener = defineFixture({ width: 720, render: () => <Opener /> })
