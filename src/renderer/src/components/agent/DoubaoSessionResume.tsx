import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { runtimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { createWebRuntimeSessionTerminal } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { normalizeAgentProviderSession } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

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
      const target = runtimeTargetForWorktreeOwner(
        useAppStore.getState(),
        worktreeId,
        executionHostId
      )
      if (target.kind === 'environment') {
        const result = await createWebRuntimeSessionTerminal(
          {
            worktreeId,
            environmentId: target.environmentId,
            agentSessionKind: 'resume',
            launchAgent: 'doubao',
            providerSession,
            // An older owner cannot preserve the selected provider session and its launch settings.
            legacyAgentLaunch: async () => {
              throw new Error(
                t(
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
      } else {
        await callRuntimeRpc(target, 'terminal.ensureAgentSession', {
          kind: 'explicit',
          worktree: toRuntimeWorktreeSelector(worktreeId),
          agent: 'doubao',
          providerSession,
          presentation: 'focused'
        })
      }
      onResumed()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      running.current = false
      setPending(false)
    }
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
