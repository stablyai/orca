import { useAppStore } from '@/store'
import {
  currentCodexAccountRestart,
  type CodexAccountRestartToken
} from '@/store/terminals/codex-account-restart-continuation'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { resolveCodexAccountRestartPane } from './codex-account-restart-owner'

export async function verifyCodexAccountRestartResult(
  token: CodexAccountRestartToken,
  result: { id: string; incarnationId?: string | null }
): Promise<boolean> {
  const request = currentCodexAccountRestart(useAppStore.getState(), token)
  if (!request || !result.incarnationId) {
    return false
  }
  const resolved = await resolveCodexAccountRestartPane(request)
  const latest = currentCodexAccountRestart(useAppStore.getState(), token)
  if (!resolved || !latest) {
    return false
  }
  const { terminal, snapshot, environmentId } = resolved
  if (
    snapshot.hostEpoch !== request.condition?.hostEpoch ||
    !snapshot.owner ||
    !('connected' in terminal) ||
    terminal.connected !== true ||
    !('ptyId' in terminal) ||
    terminal.ptyId !== snapshot.owner.ptyId ||
    !('handle' in terminal) ||
    typeof terminal.handle !== 'string'
  ) {
    return false
  }
  const ptyId = environmentId
    ? toRemoteRuntimePtyId(terminal.handle, environmentId)
    : snapshot.owner.ptyId
  if (ptyId !== result.id || snapshot.owner.incarnationId !== result.incarnationId) {
    useAppStore.getState().updateCodexAccountRestart(token, null)
    return false
  }
  return latest.resultPtyId === result.id && latest.resultIncarnationId === result.incarnationId
}
