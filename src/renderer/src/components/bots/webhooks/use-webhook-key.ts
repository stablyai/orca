// Reveal and Copy for a hook's key. The key is fetched on the owner's click and held only in this
// hook's state. Callers mount the hook per key scope (see webhookKeyScope), so a change of host,
// hook, state, key generation or account discards it.
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WebhookKey, WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import {
  callWebhookHost,
  webhookErrorCode,
  webhookHostKey,
  type WebhookHostTarget
} from './webhook-host-client'
import { webhookErrorMessage } from './webhook-copy'
import { copyWebhookSecret } from './webhook-secret-copy'

export type WebhookKeyCopy = 'url' | 'key'

export type WebhookKeyControls = {
  revealed: WebhookKey | null
  busy: boolean
  reveal: () => void
  hide: () => void
  /** Resolves whether it copied; `quiet` leaves the confirmation to the caller. */
  copy: (what: WebhookKeyCopy, options?: { quiet?: boolean }) => Promise<boolean>
}

/** Everything a shown key belongs to; the key fields remount, dropping it, when this changes. */
export function useWebhookKeyScope(target: WebhookHostTarget, summary: WebhookSummary): string {
  const account = useAppStore((s) =>
    s.orcaProfileAuthStatus
      ? `${s.orcaProfileAuthStatus.activeProfileId}:${s.orcaProfileAuthStatus.state}`
      : 'signed-out'
  )
  return [
    webhookHostKey(target),
    summary.hookId,
    summary.state,
    summary.keyGeneration,
    account
  ].join('|')
}

/** The hook a copy reads its key from: its execution host, and the bot named in errors. */
export type WebhookKeySource = { target: WebhookHostTarget; hookId: string; botName: string }

/** The hook's key and key-bearing URL from its host; a failure toasts unless `wanted` says it's stale. */
async function revealWebhookKey(
  { target, hookId, botName }: WebhookKeySource,
  wanted: () => boolean = () => true
): Promise<WebhookKey | null> {
  try {
    const key = await callWebhookHost(target, 'webhooks.reveal', { hookId })
    return wanted() ? key : null
  } catch (error) {
    if (wanted()) {
      toast.error(webhookErrorMessage(webhookErrorCode(error), botName, target))
    }
    return null
  }
}

function writeWebhookKey(
  what: WebhookKeyCopy,
  key: WebhookKey,
  options?: { quiet?: boolean }
): Promise<boolean> {
  return copyWebhookSecret(
    what === 'url' ? key.url : key.key,
    what === 'url'
      ? translate('bots.webhooks.copiedUrl', 'URL copied')
      : translate('bots.webhooks.copiedKey', 'Key copied'),
    options
  )
}

/** Every "Copy URL": fetches the hook's whole URL, key included, from its host and copies it without
 *  showing it. `quiet` leaves the confirmation to the caller. Resolves whether it copied. */
export async function copyWebhookUrl(
  source: WebhookKeySource,
  options?: { quiet?: boolean }
): Promise<boolean> {
  const key = await revealWebhookKey(source)
  return key ? writeWebhookKey('url', key, options) : false
}

export function useWebhookKey(source: WebhookKeySource): WebhookKeyControls {
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
      return await revealWebhookKey(source, () => request === generation.current)
    } finally {
      setBusy(false)
    }
  }

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
    copy: (what, options) => {
      // Copy never puts the key on screen; a shown key is copied as is.
      if (revealed) {
        return writeWebhookKey(what, revealed, options)
      }
      return fetchKey().then((key) => (key ? writeWebhookKey(what, key, options) : false))
    }
  }
}
