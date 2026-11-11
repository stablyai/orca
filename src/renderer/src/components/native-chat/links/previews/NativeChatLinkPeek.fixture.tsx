import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { NativeChatLinkPeek } from './NativeChatLinkPeek'
import { NativeChatLinkPeekContext } from './native-chat-link-peek-context'

const previewContext = {
  githubRepo: null,
  webPreviews: { runtimeEnvironmentId: null },
  issueKeys: new Map<string, string>(),
  linearConnected: false,
  jiraSites: [],
  gitLabLookupRepo: null,
  referenceChips: 'full' as const
}

function LinkPreview() {
  const [request, setRequest] = useState<LinkActionRequest | null>(null)
  return (
    <NativeChatLinkPeekContext.Provider value={previewContext}>
      <div className="native-chat-appearance h-80 p-8 pt-56 text-sm text-chat-foreground">
        See{' '}
        <NativeChatLinkPeek href="https://example.com">
          <a
            href="https://example.com"
            className="underline"
            onClick={(event) => {
              event.preventDefault()
              const anchor = event.currentTarget
              const bounds = anchor.getBoundingClientRect()
              setRequest({
                kind: 'url',
                destination: anchor.href,
                anchorX: bounds.left,
                anchorY: bounds.top,
                primary: { label: 'Orca Browser', external: false, run: () => {} },
                alternate: { label: 'System Browser', external: true, run: () => {} },
                restoreFocus: () => anchor.focus()
              })
            }}
          >
            the linked page
          </a>
        </NativeChatLinkPeek>
        .
        <LinkActionPopover request={request} onClose={() => setRequest(null)} />
      </div>
    </NativeChatLinkPeekContext.Provider>
  )
}

export const opened = defineFixture({
  width: 640,
  setup: () => {
    window.api.linkPreview.get = async ({ url }) => ({
      kind: 'page',
      preview: {
        url,
        title: 'Example page',
        description: 'A preview of the linked page.',
        siteName: 'Example',
        imageDataUrl: null,
        faviconDataUrl: null
      }
    })
  },
  render: () => <LinkPreview />,
  interact: async (frame) => {
    const link = frame.querySelector('a')
    if (!link) {
      throw new Error('Missing preview link')
    }
    link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    link.focus()
    link.click()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
