import type {
  TerminalDraftBeginResult,
  TerminalDraftClient,
  TerminalDraftSaveResult,
  TerminalDraftSubmitResult
} from '../../../shared/terminal-draft-contract'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'

const DESKTOP_DRAFT_CLIENT: TerminalDraftClient = { id: 'orca-desktop-draft', type: 'desktop' }

/**
 * Draft editing is a paired-runtime capability: the adapter lives beside the agent process.
 * A local pane keeps the existing terminal input path until it has a host handle to address.
 */
function requireRemoteDraftTarget(ptyId: string): {
  target: { kind: 'environment'; environmentId: string }
  terminal: string
} {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner || ptyId === '') {
    throw new Error('draft_editor_requires_remote_runtime')
  }
  return owner
}

export function beginDesktopTerminalDraft(
  ptyId: string,
  force = false
): Promise<TerminalDraftBeginResult> {
  const owner = requireRemoteDraftTarget(ptyId)
  return callRuntimeRpc<TerminalDraftBeginResult>(
    owner.target,
    'terminal.draft.begin',
    { terminal: owner.terminal, client: DESKTOP_DRAFT_CLIENT, ...(force ? { force: true } : {}) },
    { timeoutMs: 15_000 }
  )
}

export function saveDesktopTerminalDraft(input: {
  ptyId: string
  epoch: number
  baseToken: string
  text: string
  operationId: string
}): Promise<TerminalDraftSaveResult> {
  const owner = requireRemoteDraftTarget(input.ptyId)
  return callRuntimeRpc<TerminalDraftSaveResult>(
    owner.target,
    'terminal.draft.save',
    {
      terminal: owner.terminal,
      client: DESKTOP_DRAFT_CLIENT,
      epoch: input.epoch,
      baseToken: input.baseToken,
      text: input.text,
      operationId: input.operationId
    },
    { timeoutMs: 15_000 }
  )
}

export function submitDesktopTerminalDraft(input: {
  ptyId: string
  epoch: number
  baseToken: string
  text: string
  operationId: string
}): Promise<TerminalDraftSubmitResult> {
  const owner = requireRemoteDraftTarget(input.ptyId)
  return callRuntimeRpc<TerminalDraftSubmitResult>(
    owner.target,
    'terminal.draft.submit',
    {
      terminal: owner.terminal,
      client: DESKTOP_DRAFT_CLIENT,
      epoch: input.epoch,
      baseToken: input.baseToken,
      text: input.text,
      operationId: input.operationId
    },
    { timeoutMs: 20_000 }
  )
}

export function releaseDesktopTerminalDraft(ptyId: string, epoch: number): Promise<unknown> {
  const owner = requireRemoteDraftTarget(ptyId)
  return callRuntimeRpc(
    owner.target,
    'terminal.draft.release',
    { terminal: owner.terminal, client: DESKTOP_DRAFT_CLIENT, epoch },
    { timeoutMs: 5_000 }
  )
}
