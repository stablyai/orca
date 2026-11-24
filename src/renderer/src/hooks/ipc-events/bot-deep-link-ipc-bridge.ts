import { targetBotLinkItem } from '@/lib/agent-session/open/bot-link-item-target'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { activateAiVaultStructuredSession } from '@/lib/agent-session/open/activate-ai-vault-structured-session'
import type { BotDeepLinkOutcome } from '../../../../shared/bot-deep-link'
import { watchAccessRequests } from '@/lib/bot-access-requests'
import { openAccessRequestLink, openBotLinkHome } from '@/lib/bot-link-open'
import { openBotShareLink } from '@/components/bots/sharing/bot-share-receive-open'
import {
  CONNECTOR_SETTINGS_PANE,
  connectorConnectedMessage,
  connectorTripErrorMessage
} from '@/components/bots/connector-trip-copy'
import { redeemConnectorLink } from '@/lib/connector-connect-state'
import { isConnectorSetupOpen } from '@/lib/connector-setup-open'
import { botHostTarget } from '@/lib/bot-hosts'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'

function openBotLink(outcome: BotDeepLinkOutcome): void {
  if (outcome.kind === 'chat') {
    // The chat path every session list uses: it reveals a closed tab and explains its own failures.
    // Main found the link in this app's own store, so the chat is this app's, whatever is selected.
    const { workspaceId, sessionId } = outcome
    targetBotLinkItem(sessionId, outcome.itemId)
    void activateAiVaultStructuredSession(
      { structuredSession: { workspaceId, sessionId } },
      undefined,
      botHostTarget(LOCAL_EXECUTION_HOST_ID)
    )
  } else if (outcome.kind === 'home') {
    void openBotLinkHome(outcome.botId, outcome.conversation ?? null)
  } else if (outcome.kind === 'missing') {
    toast.info(translate('bots.deepLink.missing', "That conversation isn't open on this computer."))
  } else if (outcome.kind === 'bot-share') {
    // Straight to the review: no model turn, nothing created until the owner's Create.
    openBotShareLink(outcome.shareId)
  } else if (outcome.kind === 'access-request') {
    void openAccessRequestLink(outcome.token)
  } else if (outcome.kind === 'connector-link') {
    // The "Open Orca" fallback of a connect trip: redeemed at once; an open setup dialog carries on.
    const { source, token } = outcome
    void redeemConnectorLink(source, token).then((result) => {
      if (isConnectorSetupOpen()) {
        return
      }
      if (!result.ok) {
        toast.error(connectorTripErrorMessage(source, result.error, null))
        return
      }
      toast.success(connectorConnectedMessage(source))
      const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
      openSettingsTarget({ pane: CONNECTOR_SETTINGS_PANE[source], repoId: null })
      openSettingsPage()
    })
  }
}

/** Pulls until none is left, since one doorbell can stand for two links. */
function pullBotLink(): void {
  void window.api.ui
    .consumePendingBotLink()
    .then((outcome) => {
      if (outcome) {
        openBotLink(outcome)
        pullBotLink()
      }
    })
    .catch((error: unknown) => console.error('Failed to open the bot link:', error))
}

/** "Open in Orca" on a bot's thread: main holds the link until this window can show its tab. */
export function registerBotDeepLinkIpcBridge(unsubs: (() => void)[]): void {
  // Startup restoration replaces tabs; keep the link in main until it finishes.
  if (!useAppStore.getState().workspaceSessionReady) {
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.workspaceSessionReady) {
        unsubscribe()
        registerBotDeepLinkIpcBridge(unsubs)
      }
    })
    unsubs.push(unsubscribe)
    return
  }
  unsubs.push(watchAccessRequests())
  unsubs.push(window.api.ui.onBotLinkPending(pullBotLink))
  pullBotLink()
}
