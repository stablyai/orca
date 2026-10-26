import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Trans } from 'react-i18next'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { i18n, translate } from '@/i18n/i18n'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { makePaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { terminalTreeHasLeaf } from '../../../../shared/terminal-tab-close'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  toWebTerminalSurfaceTabId,
  toHostSessionTabId
} from '../../../../shared/terminal-surface-id'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import {
  structuredAgentSessionOwnerInputs,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { subscribeAcceptedWebSessionTerminalHandle } from '@/runtime/web-session-terminal-handle-events'
import {
  onRuntimeEnvironmentRevisionsChanged,
  onRuntimeEnvironmentsRetired
} from '@/runtime/runtime-environment-revision'
import type { AgentSessionHoldingTerminal } from '../../../../shared/agent-session-holding-terminal'
import type { TerminalPaneRevealTarget } from '../../../../shared/terminal-pane-reveal'
import {
  HELD_TERMINAL_CONTINUE_SENTENCE,
  HELD_TERMINAL_OPEN_SENTENCE
} from '../../../../shared/agent-session-failure-copy'
import { captureHeldTerminal, closeHoldingTerminal } from './close-holding-terminal'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type HeldTerminalTarget = TerminalPaneRevealTarget & {
  executionHostId: ExecutionHostId
  incarnationId: string
  ptyId: string | null
  paneKey: string
  title: string
}

/** Candidates stay unnamed until the host verifies the refusal's original execution. */
export function resolveHeldTerminalTarget(
  state: AppState,
  terminal: AgentSessionHoldingTerminal | undefined,
  executionHostId: ExecutionHostId
): HeldTerminalTarget | null {
  const host = parseExecutionHostId(executionHostId)
  const pane = terminal && parsePaneKey(terminal.paneKey)
  if (!terminal?.incarnationId || !pane || !host || hasWorktreeSleepIntent(terminal.worktreeId)) {
    return null
  }
  const tabId = host.kind === 'runtime' ? toWebTerminalSurfaceTabId(pane.tabId) : pane.tabId
  const tab = state.tabsByWorktree[terminal.worktreeId]?.find((t) => t.id === tabId)
  const layout = state.terminalLayoutsByTabId[tabId]
  if (!tab || !terminalTreeHasLeaf(layout?.root, pane.leafId)) {
    return null
  }
  const unified = state.unifiedTabsByWorktree[terminal.worktreeId]?.find(
    (t) => t.contentType === 'terminal' && (t.entityId === tabId || t.id === tabId)
  )
  if (
    structuredAgentSessionOwnerForTab(state, unified ?? { worktreeId: terminal.worktreeId }) !==
    executionHostId
  ) {
    return null
  }
  return {
    worktreeId: terminal.worktreeId,
    tabId,
    leafId: pane.leafId,
    paneKey: makePaneKey(tabId, pane.leafId),
    executionHostId,
    incarnationId: terminal.incarnationId,
    ptyId: layout?.ptyIdsByLeafId?.[pane.leafId] ?? null,
    title: resolveTerminalTabTitle(tab, state.settings?.tabAutoGenerateTitle === true, 'Terminal')
  }
}

function useHeldTerminalTarget(
  terminal: AgentSessionHoldingTerminal | undefined,
  executionHostId: ExecutionHostId | undefined
) {
  const { paneKey, worktreeId, incarnationId } = terminal ?? {}
  const select = useMemo(() => {
    const metadata = paneKey && worktreeId ? { paneKey, worktreeId, incarnationId } : undefined
    let inputs: unknown[] = [],
      candidate: HeldTerminalTarget | null = null
    return (state: AppState) => {
      const pane = metadata && parsePaneKey(metadata.paneKey)
      const host = executionHostId && parseExecutionHostId(executionHostId)
      const tabId =
        pane && (host?.kind === 'runtime' ? toWebTerminalSurfaceTabId(pane.tabId) : pane.tabId)
      const next = [
        metadata && state.tabsByWorktree[metadata.worktreeId],
        metadata && state.unifiedTabsByWorktree[metadata.worktreeId],
        tabId && state.terminalLayoutsByTabId[tabId],
        metadata && hasWorktreeSleepIntent(metadata.worktreeId),
        state.settings?.tabAutoGenerateTitle,
        ...structuredAgentSessionOwnerInputs(state)
      ]
      if (next.some((value, index) => value !== inputs[index])) {
        inputs = next
        const resolved = executionHostId
          ? resolveHeldTerminalTarget(state, metadata, executionHostId)
          : null
        if (JSON.stringify(resolved) !== JSON.stringify(candidate)) {
          candidate = resolved
        }
      }
      return candidate
    }
  }, [paneKey, worktreeId, incarnationId, executionHostId])
  const candidate = useAppStore(select)
  const [verified, setVerified] = useState<{
    target: HeldTerminalTarget
    canClose: boolean
  } | null>(null)
  useEffect(() => {
    if (!candidate) {
      return
    }
    let current = true
    const invalidate = () => {
      current = false
      setVerified(null)
    }
    const host = parseExecutionHostId(candidate.executionHostId)
    const stop =
      host?.kind === 'runtime'
        ? subscribeAcceptedWebSessionTerminalHandle(
            {
              environmentId: host.environmentId,
              worktreeId: candidate.worktreeId,
              hostTabId: toHostSessionTabId(candidate.tabId),
              leafId: candidate.leafId
            },
            (update) => {
              if (!update.surfacePresent || update.incarnationId !== candidate.incarnationId) {
                invalidate()
              }
            }
          )
        : window.api.pty.onSpawned((event) => {
            if (event.id === candidate.ptyId && event.incarnationId !== candidate.incarnationId) {
              invalidate()
            }
          })
    const stopExit =
      host?.kind === 'runtime'
        ? () => {}
        : window.api.pty.onExit((event) => {
            if (event.id === candidate.ptyId) {
              invalidate()
            }
          })
    const changed = (ids: readonly string[]) => {
      if (host?.kind === 'runtime' && ids.includes(host.environmentId)) {
        invalidate()
      }
    }
    const stopRevision = onRuntimeEnvironmentRevisionsChanged(changed)
    const stopRetirement = onRuntimeEnvironmentsRetired(changed)
    void captureHeldTerminal(candidate).then((captured) => {
      if (current) {
        setVerified(
          captured
            ? { target: candidate, canClose: captured.supportsPinCloseConsent === true }
            : null
        )
      }
    }, invalidate)
    return () => {
      current = false
      stop()
      stopExit()
      stopRevision()
      stopRetirement()
    }
  }, [candidate])
  return verified?.target === candidate ? verified : null
}

export const closeHoldingTerminalLabel = () =>
  translate('components.native-chat.heldTerminal.close', 'Close terminal')
export function HeldTerminalSentence({
  target,
  agent,
  inChat = true
}: {
  target: HeldTerminalTarget
  agent: string
  inChat?: boolean
}): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={
        inChat
          ? translate(
              'components.native-chat.heldTerminal.continue',
              HELD_TERMINAL_CONTINUE_SENTENCE
            )
          : translate('components.native-chat.heldTerminal.open', HELD_TERMINAL_OPEN_SENTENCE)
      }
      values={{ agent, terminal: target.title }}
      components={{
        terminal: (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void captureHeldTerminal(target).then((current) => {
                if (current) {
                  revealTerminalPane(target)
                }
              })
            }}
          />
        )
      }}
    />
  )
}

export function useHeldTerminalNotice(
  terminal: AgentSessionHoldingTerminal | undefined,
  executionHostId: ExecutionHostId | undefined,
  agent: string,
  inChat = true
) {
  const verified = useHeldTerminalTarget(terminal, executionHostId)
  const target = verified?.target
  const canClose = verified?.canClose === true
  const busy = useRef(false)
  const [closing, setClosing] = useState(false)
  return useMemo(
    () =>
      target || closing
        ? {
            content: target ? (
              <HeldTerminalSentence target={target} agent={agent} inChat={inChat} />
            ) : undefined,
            action:
              canClose || closing
                ? {
                    label: closeHoldingTerminalLabel(),
                    disabled: closing,
                    onClick: () => {
                      if (busy.current || !target) {
                        return
                      }
                      busy.current = true
                      setClosing(true)
                      void closeHoldingTerminal(target).finally(() => {
                        busy.current = false
                        setClosing(false)
                      })
                    }
                  }
                : undefined
          }
        : null,
    [target, canClose, closing, agent, inChat]
  )
}

type HeldTerminalToastInput = {
  terminal?: AgentSessionHoldingTerminal
  executionHostId: ExecutionHostId
  agent: string
  fallback: string
}
function HeldTerminalToast({ input, id }: { input: HeldTerminalToastInput; id: string }) {
  const notice = useHeldTerminalNotice(input.terminal, input.executionHostId, input.agent, false)
  useEffect(() => {
    toast.error(<HeldTerminalToast input={input} id={id} />, {
      id,
      action: notice?.action,
      duration: notice?.action?.disabled ? Infinity : 4_000
    })
  }, [input, id, notice])
  return notice?.content ?? input.fallback
}
export function toastHeldTerminal(input: HeldTerminalToastInput): void {
  if (!input.terminal?.incarnationId) {
    toast.error(input.fallback)
    return
  }
  const id = createBrowserUuid()
  toast.error(<HeldTerminalToast input={input} id={id} />, { id })
}
