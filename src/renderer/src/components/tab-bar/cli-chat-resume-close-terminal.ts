import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { collectTabPtyIds } from '../terminal/running-terminal-close-guard'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { toHostSessionPaneKey } from '../../../../shared/terminal-surface-id'
import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import type {
  RuntimeTerminalResolvePane,
  RuntimeTerminalWait
} from '../../../../shared/runtime-types'
import type { CliChatResumeSource } from './cli-chat-resume-source'

export type CliChatResumeCloseHooks = {
  /** The host answered for every pane; what follows waits on the user or on the exits. */
  prepared: () => void
  closing: () => void
  /** The user agreed to close, but the terminal changed first, so it stays open; the run
   *  decides whether it, or a newer continuation of the tab, answers. */
  refused: () => void
}

export async function closeCliChatResumeTerminal(
  source: CliChatResumeSource,
  isCurrent: () => boolean,
  hooks: CliChatResumeCloseHooks,
  signal: AbortSignal
): Promise<boolean> {
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  const leafId = source.paneKey.slice(source.tabId.length + 1)
  const state = useAppStore.getState()
  const ptyIds = collectTabPtyIds(state, source.tabId)
  const bindings = state.terminalLayoutsByTabId[source.tabId]?.ptyIdsByLeafId ?? {}
  const leaves = new Set([leafId, ...Object.keys(bindings).filter((leaf) => bindings[leaf])])
  const originals = [...leaves].map((leaf) =>
    captureTerminalSurfaceIdentity(state, source.workspaceId, source.tabId, leaf)
  )
  if (
    !target ||
    originals.some((original) => !original) ||
    ptyIds.some((id) => !Object.values(bindings).includes(id))
  ) {
    throw new Error('terminal unavailable')
  }
  const terminals = await Promise.all(
    [...leaves].map(async (leaf) => {
      const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
        target,
        'terminal.resolvePane',
        {
          paneKey: toHostSessionPaneKey(`${source.tabId}:${leaf}`),
          worktreeId: source.workspaceId
        },
        { signal }
      )
      const original = originals.find((entry) => entry?.leafId === leaf)
      if (
        !terminal.ptyId ||
        !terminal.incarnationId ||
        !isCurrent() ||
        (original?.incarnationId && original.incarnationId !== terminal.incarnationId)
      ) {
        throw new Error('terminal unavailable')
      }
      return terminal
    })
  )
  hooks.prepared()
  return await new Promise<boolean>((resolve, reject) => {
    let started = false
    const cancel = () => {
      if (started) {
        return
      }
      signal.removeEventListener('abort', cancel)
      resolve(false)
    }
    signal.addEventListener('abort', cancel, { once: true })
    closeTerminalTab(source.tabId, {
      // Continuing is the user's consent to stop this pane's agent, so only other panes' work asks.
      ...(bindings[leafId] ? { consentedPtyId: bindings[leafId] } : {}),
      // The chat opens in this worktree, so emptying it must not leave it.
      preserveWorktreeSelection: true,
      onCancel: cancel,
      beforeClose: () => {
        const current = useAppStore.getState()
        const currentPtyIds = collectTabPtyIds(current, source.tabId)
        if (
          started ||
          signal.aborted ||
          !isCurrent() ||
          currentPtyIds.length !== ptyIds.length ||
          currentPtyIds.some((id) => !ptyIds.includes(id)) ||
          originals.some((original) => {
            if (!original) {
              return true
            }
            const next = captureTerminalSurfaceIdentity(
              current,
              source.workspaceId,
              source.tabId,
              original.leafId
            )
            return !next || !isRetainedTerminalSurfaceIdentity(original, next)
          })
        ) {
          if (!started) {
            hooks.refused()
          }
          return false
        }
        started = true
        signal.removeEventListener('abort', cancel)
        // Skip the already-checked compatibility await so every handle's wait is sent before close.
        const exited = Promise.all(
          terminals.map((terminal) =>
            callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
              target,
              'terminal.wait',
              {
                terminal: terminal.handle,
                for: 'exit',
                timeoutMs: 15_000
              },
              { signal, timeoutMs: 16_000, skipCompatibilityCheck: true }
            )
          )
        )
        hooks.closing()
        void exited
          .then((results) => {
            if (
              results.some(
                ({ wait }) =>
                  !wait.satisfied ||
                  wait.status !== 'exited' ||
                  ((wait.exitCode === null || wait.exitCode < 0) &&
                    wait.exitCause?.kind !== 'operator_close' &&
                    wait.exitCause?.kind !== 'signaled')
              )
            ) {
              throw new Error('terminal exit unproven')
            }
            resolve(true)
          })
          .catch(reject)
        return true
      }
    })
  })
}
