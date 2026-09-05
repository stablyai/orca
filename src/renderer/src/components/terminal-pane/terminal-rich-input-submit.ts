import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import { pasteTextIntoTerminalPane } from './terminal-programmatic-text-paste'
import { waitForRichInputPasteDelivery } from './terminal-rich-input-delivery-wait'

export const TERMINAL_RICH_INPUT_SUBMIT_DELAY_MS = 500
export const TERMINAL_RICH_INPUT_IMAGE_SETTLE_MS = 300

export type TerminalRichInputSubmitResult =
  | { status: 'not-started' }
  | { status: 'partially-written'; imagePathsWritten: number; textWritten: boolean }
  // `deliveryConfirmed: false` means Enter was sent without ever seeing the agent
  // redraw, so the prompt may still be sitting unsent in the agent's editor.
  | { status: 'submitted'; deliveryConfirmed: boolean }

type SubmitTerminalRichInputArgs = {
  text: string
  imagePaths?: readonly string[]
  tabId: string
  worktreeId: string
  pane: ManagedPane
  transport: PtyTransport | undefined
  getManager: () => PaneManager | null
  getPaneTransports: () => Map<number, PtyTransport>
  delay?: (milliseconds: number) => Promise<void>
}

/** Pastes the composed block first, then submits only if the same PTY still owns the leaf. */
export async function submitTerminalRichInput({
  text,
  imagePaths = [],
  tabId,
  worktreeId,
  pane,
  transport,
  getManager,
  getPaneTransports,
  delay = wait
}: SubmitTerminalRichInputArgs): Promise<TerminalRichInputSubmitResult> {
  const ptyId = transport?.getPtyId() ?? null
  if ((!text.trim() && imagePaths.length === 0) || !transport || !ptyId) {
    return { status: 'not-started' }
  }
  let imagePathsWritten = 0
  let textWritten = false
  const interruptedResult = (): TerminalRichInputSubmitResult =>
    imagePathsWritten > 0 || textWritten
      ? { status: 'partially-written', imagePathsWritten, textWritten }
      : { status: 'not-started' }
  for (const imagePath of imagePaths) {
    const pastedImage = await pasteTextIntoTerminalPane({
      text: imagePath,
      tabId,
      worktreeId,
      pane,
      transport,
      getManager,
      getPaneTransports,
      forceBracketedPaste: true
    })
    if (!pastedImage) {
      return interruptedResult()
    }
    imagePathsWritten += 1
  }
  if (imagePaths.length > 0) {
    await delay(TERMINAL_RICH_INPUT_IMAGE_SETTLE_MS)
  }
  if (text.trim()) {
    const pastedText = await pasteTextIntoTerminalPane({
      text,
      tabId,
      worktreeId,
      pane,
      transport,
      getManager,
      getPaneTransports
    })
    if (!pastedText) {
      return interruptedResult()
    }
    textWritten = true
  }

  // Why: busy agent TUIs can process Enter before a freshly pasted prompt has
  // reached their editor, leaving the prompt queued but unsent. Wait for the agent's
  // own redraw rather than a fixed sleep, so a slow link widens the wait and a fast
  // local pane stops paying the full fallback.
  const delivery = await waitForRichInputPasteDelivery({
    terminal: pane.terminal,
    fallbackDelayMs: TERMINAL_RICH_INPUT_SUBMIT_DELAY_MS,
    delay
  })
  const currentPane = getManager()
    ?.getPanes()
    .find((candidate) => candidate.leafId === pane.leafId)
  const currentTransport = currentPane ? getPaneTransports().get(currentPane.id) : undefined
  if (
    !currentPane ||
    currentTransport !== transport ||
    !currentTransport.isConnected() ||
    currentTransport.getPtyId() !== ptyId
  ) {
    return interruptedResult()
  }
  currentPane.terminal.input('\r')
  currentPane.terminal.scrollToBottom()
  recordTerminalUserInputForLeaf(tabId, currentPane.leafId)
  return { status: 'submitted', deliveryConfirmed: delivery.confirmed }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
