// Subscribe through the local renderer bridge or a headless host’s pairing offer.

import type { Page } from '@stablyai/playwright-test'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection'
import { decodePairingOffer } from '../../../src/shared/pairing'
import { subscribeRemoteRuntimeRequest } from '../../../src/shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../src/shared/runtime-rpc-envelope'
import type { LiveLayoutFeed } from './workspace-layout-oracle-feed'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    /** Forwards each layout stream response from the renderer to the oracle. */
    __oracleLayoutFrame?: (response: RuntimeRpcResponse<unknown>) => Promise<void>
  }
}

function applyResponse(feed: LiveLayoutFeed, response: RuntimeRpcResponse<unknown>): void {
  if (response.ok) {
    feed.apply(response.result)
  } else {
    feed.fail(`layout stream error: ${response.error.code}: ${response.error.message}`)
  }
}

// Bindings survive a reload, and a second registration on one page throws.
const boundPages = new WeakSet<Page>()

/** Subscribes in the window's renderer; call again after a reload, which ends the old stream. */
export async function subscribeWindowLayout(page: Page, feed: LiveLayoutFeed): Promise<void> {
  feed.reopening()
  if (!boundPages.has(page)) {
    boundPages.add(page)
    await page.exposeFunction('__oracleLayoutFrame', (response: RuntimeRpcResponse<unknown>) =>
      applyResponse(feed, response)
    )
  }
  await page.evaluate(async () => {
    await window.api.runtime.subscribe({ method: 'layout.subscribe', params: {} }, (response) => {
      void window.__oracleLayoutFrame?.(response)
    })
  })
}

/** Subscribes over a headless host's pairing offer; a serve restart ends it, so reopen after one. */
export async function subscribeHeadlessLayout(
  pairingUrl: string,
  feed: LiveLayoutFeed
): Promise<{ close: () => void }> {
  feed.reopening()
  const subscription = await subscribeRemoteRuntimeRequest<unknown>(
    pairedRuntimeConnectionFromOffer(decodePairingOffer(pairingUrl)),
    'layout.subscribe',
    {},
    30_000,
    {
      onResponse: (response) => applyResponse(feed, response),
      onError: (error) => feed.fail(`layout stream error: ${error.message}`),
      onClose: () => feed.reopening()
    }
  )
  return { close: () => subscription.close() }
}
