import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { getPairedWebClientEnvironmentId } from '@/app-shell/platform/paired-web-client-host'
import { runtimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'

async function resumeDoubaoSession(
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined,
  providerSession: AgentProviderSessionMetadata
): Promise<void> {
  const target = runtimeTargetForWorktreeOwner(useAppStore.getState(), worktreeId, executionHostId)
  if (target.kind === 'local' && !isPairedWebClientWindow()) {
    await callRuntimeRpc(target, 'terminal.ensureAgentSession', {
      kind: 'explicit',
      worktree: toRuntimeWorktreeSelector(worktreeId),
      agent: 'doubao',
      providerSession,
      presentation: 'focused'
    })
    return
  }
  // The browser already knows its pairing while the renderer's host catalog is still loading.
  const environmentId =
    target.kind === 'environment'
      ? target.environmentId
      : getPairedWebClientEnvironmentId({
          runtimeEnvironments: await window.api.runtimeEnvironments.list()
        })
  const result = await createWebRuntimeSessionTerminalOnHost(
    {
      worktreeId,
      environmentId,
      agentSessionKind: 'resume',
      launchAgent: 'doubao',
      providerSession,
      // An older owner cannot preserve the selected provider session and its launch settings.
      legacyAgentLaunch: async () => {
        throw new Error(
          translate(
            'agentLaunch.updateServer',
            'Update Orca on this workspace’s server, then try again.'
          )
        )
      },
      activate: true
    },
    { notifyFailure: false }
  )
  if (result.status === 'failed') {
    throw new Error(result.message)
  }
}

export function DoubaoSessionResume({
  worktreeId,
  executionHostId,
  disabled,
  onResumed
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
  disabled?: boolean
  onResumed: () => void
}) {
  const t = useTranslate()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const running = useRef(false)
  const providerSession = normalizeAgentProviderSession({ key: 'session_id', id: value })
  const ready = !disabled && !pending && Boolean(providerSession)
  const label = t('agentPicker.doubaoSessionId', 'Session ID shown by Doubao on exit')
  const resume = async () => {
    if (!ready || !providerSession || running.current) {
      return
    }
    running.current = true
    setPending(true)
    setError('')
    try {
      await resumeDoubaoSession(worktreeId, executionHostId, providerSession)
      onResumed()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
    running.current = false
    setPending(false)
  }
  return (
    <details
      className="border-t border-border px-2.5 py-2 text-xs"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <summary className="cursor-pointer text-muted-foreground">
        {t('agentPicker.resumeById', 'Resume a session by ID')}
      </summary>
      <div className="mt-2 flex items-center gap-2">
        <Input
          aria-label={label}
          placeholder={label}
          value={value}
          maxLength={512}
          inputMode="numeric"
          autoComplete="off"
          disabled={disabled || pending}
          className="h-8 min-w-0 flex-1"
          onChange={(event) => {
            setValue(event.target.value)
            setError('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event)) {
              event.preventDefault()
              void resume()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!ready}
          onClick={() => void resume()}
        >
          {t('agentPicker.resumeTerminal', 'Resume')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-destructive">
          {error}
        </p>
      ) : null}
    </details>
  )
}
