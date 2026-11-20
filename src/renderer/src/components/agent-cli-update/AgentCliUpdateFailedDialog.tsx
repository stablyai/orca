import { useEffect, useMemo, useState } from 'react'
import { Trans } from 'react-i18next'
import { AgentCommandFailedDialog } from '@/components/agent-command-failure/AgentCommandFailedDialog'
import { useStructuredAgentSessionHostPlace } from '@/components/native-chat/pane/ownership/use-structured-agent-session-host-label'
import { Button } from '@/components/ui/button'
import { i18n } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { agentCliUpdateHostTarget } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import { agentCliProductName } from './agent-cli-product-name'
import {
  readAgentCliUpdateFailureRequest,
  type AgentCliUpdateFailureRequest
} from './agent-cli-update-failure-modal'
import { useAgentCliUpdate } from './use-agent-cli-update'

/** A failed update of the user's own CLI: the command Orca ran, where, and its output. */
export default function AgentCliUpdateFailedDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  const [request] = useState(() => readAgentCliUpdateFailureRequest(modalData))
  return request ? <FailedDialog request={request} /> : null
}

function FailedDialog({ request }: { request: AgentCliUpdateFailureRequest }): React.JSX.Element {
  const t = useTranslate()
  const closeModal = useAppStore((s) => s.closeModal)
  const target = useMemo(() => agentCliUpdateHostTarget(request.hostKey), [request.hostKey])
  const { update, run } = useAgentCliUpdate(target, request.agent)
  const host = useStructuredAgentSessionHostPlace(target)
  const failed = run?.phase === 'failed' ? run : null
  // Another window's retry or a later check can clear the failure this dialog explains.
  useEffect(() => {
    if (!failed) {
      closeModal()
    }
  }, [failed, closeModal])
  const product = agentCliProductName(request.agent, t)
  const strong = <span className="font-medium text-foreground" />
  const code = <code className="rounded bg-muted px-1 font-mono text-xs text-foreground" />
  return (
    <AgentCommandFailedDialog
      open={failed !== null}
      onOpenChange={(open) => !open && closeModal()}
      title={t('agentCliUpdate.failedTitle', "Couldn't update {{product}}", { product })}
      description={
        failed?.command && update ? (
          <Trans
            i18n={i18n}
            defaults={t(
              'agentCliUpdate.failedDescription',
              'Orca ran <code>{{command}}</code> on <strong>{{host}}</strong> to update your {{product}} from <strong>{{installedVersion}}</strong> to <strong>{{latestVersion}}</strong>, and it failed.'
            )}
            values={{
              command: failed.command,
              host,
              product,
              installedVersion: update.installedVersion,
              latestVersion: update.latestVersion
            }}
            components={{ code, strong }}
          />
        ) : (
          // Nothing ran (no CLI of the user's own was found), or the host predates `command`.
          <Trans
            i18n={i18n}
            defaults={t(
              'agentCliUpdate.failedDescriptionNoCommand',
              "Orca couldn't update your {{product}} on <strong>{{host}}</strong>."
            )}
            values={{ product, host }}
            components={{ strong }}
          />
        )
      }
      error={failed?.output || t('agentCliUpdate.noOutput', 'The command printed nothing.')}
      detailsFinishedAt={failed?.finishedAt ?? null}
      action={
        <Button
          type="button"
          size="sm"
          onClick={() => {
            closeModal()
            void request.tryAgain()
          }}
        >
          {t('agentCliUpdate.tryAgain', 'Try again')}
        </Button>
      }
    />
  )
}
