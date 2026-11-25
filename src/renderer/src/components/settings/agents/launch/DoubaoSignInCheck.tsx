import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { DoubaoSignInStatus } from '../../../../../../shared/agent-launch/installation/doubao-sign-in-status'
import { Button } from '@/components/ui/button'
import { useClipboardTextCopyFeedback } from '@/hooks/clipboard/use-clipboard-text-copy-feedback'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { AgentDetectionTarget } from '@/lib/agent-session/launch/inventory/useDetectedAgents'

export function doubaoSignInCheckForTarget(target: AgentDetectionTarget, command?: string) {
  if (
    target.kind === 'ssh' ||
    target.worktreeId ||
    (target.kind === 'local' && target.contextKey)
  ) {
    return null
  }
  const environmentId = target.kind === 'runtime' ? target.environmentId : undefined
  return (
    <DoubaoSignInCheck
      key={JSON.stringify([environmentId, command])}
      environmentId={environmentId}
      command={command?.trim() || 'doubao'}
    />
  )
}

function DoubaoSignInCheck({
  environmentId,
  command
}: {
  environmentId?: string
  command: string
}) {
  const t = useTranslate()
  const [status, setStatus] = useState<DoubaoSignInStatus | 'idle' | 'checking'>('idle')
  const signIn = `${command} login`
  const { copyText, status: copied } = useClipboardTextCopyFeedback(signIn)
  const verify = async () => {
    setStatus('checking')
    try {
      const result = await callRuntimeRpc<{ status: DoubaoSignInStatus }>(
        environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
        'preflight.checkDoubaoSignIn',
        undefined,
        { timeoutMs: 15_000 }
      )
      setStatus(result.status)
    } catch {
      setStatus('unverified')
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="xs"
        disabled={status === 'checking'}
        onClick={() => void verify()}
      >
        {status === 'checking'
          ? t('settings.agents.doubaoSignIn.checking', 'Checking sign-in…')
          : t('settings.agents.doubaoSignIn.check', 'Check sign-in')}
      </Button>
      <span role="status" className="text-settings-detail text-muted-foreground">
        {status === 'signed-in' &&
          t('settings.agents.doubaoSignIn.verified', 'Signed in on this host')}
        {status === 'signed-out' &&
          t('settings.agents.doubaoSignIn.signedOut', 'Sign in on this host')}
        {status === 'unverified' &&
          t('settings.agents.doubaoSignIn.unverified', 'Could not verify sign-in on this host')}
      </span>
      {status !== 'signed-in' && (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() => void copyText()}
          aria-label={t('settings.agents.doubaoSignIn.copy', 'Copy sign-in command')}
        >
          <code>{signIn}</code>
          {copied === 'copied' ? <Check /> : <Copy />}
        </Button>
      )}
    </div>
  )
}
