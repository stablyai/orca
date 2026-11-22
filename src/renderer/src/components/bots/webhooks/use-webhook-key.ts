// Reveal and Copy for a hook's key. The key is fetched on the owner's click and held only in this
// hook's state. Callers mount the hook per key scope (see webhookKeyScope), so a change of host,
// hook, state, key generation or account discards it.
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookKey, WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import { callWebhookHost, webhookErrorCode } from './webhook-host-client'
import { webhookErrorMessage } from './webhook-copy'
import { copyWebhookSecret } from './webhook-secret-copy'

export type WebhookKeyCopy = 'url' | 'key'

export type WebhookKeyControls = {
  revealed: WebhookKey | null
  busy: boolean
  reveal: () => void
  hide: () => void
  copy: (what: WebhookKeyCopy) => void
}

/** Everything a shown key belongs to; the key fields remount, dropping it, when this changes. */
export function useWebhookKeyScope(target: RuntimeClientTarget, summary: WebhookSummary): string {
  const account = useAppStore((s) =>
    s.orcaProfileAuthStatus
      ? `${s.orcaProfileAuthStatus.activeProfileId}:${s.orcaProfileAuthStatus.state}`
      : 'signed-out'
  )
  const host = target.kind === 'local' ? 'local' : `env:${target.environmentId}`
  return [host, summary.hookId, summary.state, summary.keyGeneration, account].join('|')
}

export function useWebhookKey(options: {
  target: RuntimeClientTarget
  hookId: string
  botName: string
}): WebhookKeyControls {
  const t = useTranslate()
  const { target, hookId, botName } = options
  const [revealed, setRevealed] = useState<WebhookKey | null>(null)
  const [busy, setBusy] = useState(false)
  // Raised by every click, hide and unmount: an answer from an older generation is dropped.
  const generation = useRef(0)

  useEffect(
    () => () => {
      generation.current += 1
    },
    []
  )

  const fetchKey = async (): Promise<WebhookKey | null> => {
    const request = ++generation.current
    setBusy(true)
    try {
      const key = await callWebhookHost(target, 'webhooks.reveal', { hookId })
      return request === generation.current ? key : null
    } catch (error) {
      if (request === generation.current) {
        toast.error(webhookErrorMessage(webhookErrorCode(error), botName, target))
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  const write = (what: WebhookKeyCopy, key: WebhookKey): void =>
    copyWebhookSecret(
      what === 'url' ? key.url : key.key,
      what === 'url'
        ? t('bots.webhooks.copiedUrl', 'URL copied')
        : t('bots.webhooks.copiedKey', 'Key copied')
    )

  return {
    revealed,
    busy,
    reveal: () => {
      void fetchKey().then((key) => key && setRevealed(key))
    },
    hide: () => {
      generation.current += 1
      setRevealed(null)
    },
    copy: (what) => {
      // Copy never puts the key on screen; a shown key is copied as is.
      if (revealed) {
        write(what, revealed)
        return
      }
      void fetchKey().then((key) => key && write(what, key))
    }
  }
}
