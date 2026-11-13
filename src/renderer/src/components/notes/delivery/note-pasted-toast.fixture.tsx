import { defineFixture } from '../../../component-fixtures/component-fixture'
import { Toaster } from '@/components/ui/sonner'
import { showNotePastedToast, showWaitingNoteRefusalToast } from './note-pasted-toast'
import { activeAgentNotesSendFailureMessage } from '@/lib/agent-session/messaging/terminal/active-agent-note-send-result'

const target = { kind: 'terminal', tabId: 'stand-in-tab', leafId: 'stand-in-leaf' } as const
const args = { worktreeId: 'synthetic-workspace', target, agentLabel: 'Antigravity' }

const render = (): React.JSX.Element => (
  <>
    <div className="h-[900px]" />
    <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
  </>
)

async function showToast(show: () => void): Promise<void> {
  show()
  const deadline = performance.now() + 5_000
  while (!document.querySelector('[data-sonner-toast][data-mounted="true"]')) {
    if (performance.now() > deadline) {
      throw new Error('Toast did not mount')
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

export const pasting = defineFixture({
  width: 1280,
  render,
  interact: () => showToast(() => showNotePastedToast({ ...args, settleMs: 181_438 }))
})

export const waitingRefusal = defineFixture({
  width: 1280,
  render,
  interact: () =>
    showToast(() =>
      showWaitingNoteRefusalToast({
        ...args,
        settleMs: 181_438,
        readyMessage: activeAgentNotesSendFailureMessage('not-ready', {
          code: 'terminal-draft-pending',
          agent: args.agentLabel
        })
      })
    )
})

export const settled = defineFixture({
  width: 1280,
  render,
  interact: () => showToast(() => showNotePastedToast(args))
})

export const settledRefusal = defineFixture({
  width: 1280,
  render,
  interact: () =>
    showToast(() =>
      showWaitingNoteRefusalToast({
        ...args,
        readyMessage: activeAgentNotesSendFailureMessage('not-ready', {
          code: 'terminal-draft-pending',
          agent: args.agentLabel
        })
      })
    )
})
