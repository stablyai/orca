// Rendered-browser harness: mounts the REAL native-chat components (message
// row, tool run, full-content button, i18n catalog, Tailwind theme) in a real
// Chromium page. The payload reader talks to the test's HTTP endpoint, which
// serves ranges from a real JournalPayloadStore through readOwnedPayloadRange.
// Why not the app itself: a structured session in the e2e fixture needs the
// real Claude Agent SDK handshake with credentials the fixture strips.

import '@/assets/main.css'
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { i18n } from '@/i18n/i18n'
import { MessageRow } from '@/components/native-chat/NativeChatMessageRow'
import {
  NativeChatPayloadReaderContext,
  type NativeChatPayloadReader
} from '@/components/native-chat/native-chat-payload-reader'
import type { NativeChatMessage } from '../../../../src/shared/native-chat-types'

type HarnessConfig = {
  endpoint: string
  sessionId: string
  messages: NativeChatMessage[]
}

type PayloadRange = {
  digest: string
  byteLength: number
  chunk: string
  chunkOffset: number
  chunkByteLength: number
  complete: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The endpoint reply is data from outside the page: check its shape before use. */
function parsePayloadRange(value: unknown): PayloadRange {
  if (
    isRecord(value) &&
    typeof value.digest === 'string' &&
    typeof value.byteLength === 'number' &&
    typeof value.chunk === 'string' &&
    typeof value.chunkOffset === 'number' &&
    typeof value.chunkByteLength === 'number' &&
    typeof value.complete === 'boolean'
  ) {
    return {
      digest: value.digest,
      byteLength: value.byteLength,
      chunk: value.chunk,
      chunkOffset: value.chunkOffset,
      chunkByteLength: value.chunkByteLength,
      complete: value.complete
    }
  }
  throw new Error('payload_read_failed')
}

/** The config is fetched over HTTP, so its shape is checked before it drives the render. */
function isHarnessConfig(value: unknown): value is HarnessConfig {
  return (
    isRecord(value) &&
    typeof value.endpoint === 'string' &&
    typeof value.sessionId === 'string' &&
    Array.isArray(value.messages)
  )
}

/** The harness's stand-in for the RPC reader: same paging contract over HTTP,
 *  so the components under test see the real reader interface. */
function readerFor(config: HarnessConfig): NativeChatPayloadReader {
  return {
    async readFullPayload(digest, expectedByteLength) {
      const parts: string[] = []
      let offset = 0
      for (;;) {
        const url = new URL(config.endpoint)
        url.searchParams.set('sessionId', config.sessionId)
        url.searchParams.set('digest', digest)
        url.searchParams.set('offset', String(offset))
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(await response.text())
        }
        const range = parsePayloadRange(await response.json())
        if (range.digest !== digest || range.byteLength !== expectedByteLength) {
          throw new Error('payload_identity_changed')
        }
        parts.push(range.chunk)
        offset = range.chunkOffset + range.chunkByteLength
        if (range.complete) {
          return parts.join('')
        }
        if (range.chunkByteLength === 0) {
          throw new Error('payload_incomplete')
        }
      }
    }
  }
}

/** Renders the real message rows with a payload reader in scope, which is what
 *  the screenshot proof is taken of. */
function Harness({ config }: { config: HarnessConfig }) {
  const reader = useMemo(() => readerFor(config), [config])
  return (
    <I18nextProvider i18n={i18n}>
      <NativeChatPayloadReaderContext.Provider value={reader}>
        <div data-testid="harness-root" className="flex flex-col gap-4">
          {config.messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              expandSignal
              activityExpandOverride
              onScrollMessageToTop={() => {}}
            />
          ))}
        </div>
      </NativeChatPayloadReaderContext.Provider>
    </I18nextProvider>
  )
}

const params = new URLSearchParams(window.location.search)
const configUrl = params.get('config')
if (!configUrl) {
  throw new Error('harness config url missing')
}
void fetch(configUrl)
  .then((response) => response.json())
  .then((config: unknown) => {
    if (!isHarnessConfig(config)) {
      throw new Error('harness config malformed')
    }
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <Harness config={config} />
      </StrictMode>
    )
  })
