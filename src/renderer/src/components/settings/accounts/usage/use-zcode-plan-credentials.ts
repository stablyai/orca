import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import type { ZcodePlanCredentialsStatus } from '../../../../../../shared/agent-accounts/usage-credentials/zcode-plan-sites'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callZcodePlanCredentials } from '@/runtime/provider-accounts/usage/runtime-usage-credentials-client'
import { useUsageApiKeyCredentials } from './use-usage-api-key-credentials'

const LOCAL_OWNER: RuntimeClientTarget = { kind: 'local' }

function isZcodePlanStatus(
  next: ZcodePlanCredentialsStatus | null | undefined
): next is ZcodePlanCredentialsStatus {
  return (
    !!next &&
    typeof next.apiKeyConfigured === 'boolean' &&
    typeof next.zcodeCliConfigured === 'boolean'
  )
}

/** Key by owner so switching GLM credential hosts resets drafts. */
export function useZcodePlanCredentials(
  updatedAt: number | undefined,
  owner: RuntimeClientTarget = LOCAL_OWNER
) {
  const t = useTranslate()
  const { status, access, draft, setDraft, busy, saveApiKey, clearApiKey } =
    useUsageApiKeyCredentials({
      owner,
      updatedAt,
      call: callZcodePlanCredentials,
      isStatus: isZcodePlanStatus,
      hostCannotStoreMessage:
        'GLM Coding Plan keys can only be changed in the desktop app on the computer running Orca.',
      onMutated: (action) => {
        if (action === 'saveApiKey') {
          toast.success(
            t(
              'auto.components.settings.ZcodePlanAccountsSection.keySaved',
              'GLM Coding Plan API key saved.'
            )
          )
        }
      },
      onMutationFailed: (_action, error) =>
        toast.error(
          t(
            'auto.components.settings.ZcodePlanAccountsSection.keySaveFailed',
            'GLM Coding Plan credential update failed.'
          ),
          { description: error.message }
        )
    })
  return {
    status,
    access,
    apiKeyDraft: draft,
    setApiKeyDraft: setDraft,
    credentialBusy: busy,
    saveApiKey,
    clearApiKey
  }
}
