import { useEffect, useRef, useState } from 'react'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { PluginUsageReading } from '../../../../../shared/plugins/contributions/plugin-usage-provider-contribution'
import {
  PLUGIN_IMAGE_RULES,
  pluginImageRuleError
} from '../../../../../shared/plugins/images/plugin-image-fields'
import {
  PLUGIN_IMAGE_MIME,
  readPluginImageHeader
} from '../../../../../shared/plugins/images/plugin-image-format'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const MAX_ENCODED_ICON_LENGTH = Math.ceil(PLUGIN_IMAGE_RULES.icon.maxBytes / 3) * 4
const NO_ICONS = new Map<string, string | null>()
const ICON_RETRY_DELAY_MS = 5_000

type IconRequest = { source: Promise<string | null>; retryAt: number }

function imageSource(response: { base64: string } | null): string | null {
  const base64 = response?.base64
  if (typeof base64 !== 'string' || !base64 || base64.length > MAX_ENCODED_ICON_LENGTH) {
    return null
  }
  const bytes = decodeBase64Bytes(base64)
  const info = readPluginImageHeader(bytes)
  return typeof info === 'string' || pluginImageRuleError('icon', info, bytes.byteLength)
    ? null
    : `data:${PLUGIN_IMAGE_MIME[info.format]};base64,${base64}`
}

export function usePluginUsageIcons(
  readings: PluginUsageReading[],
  environmentId: string | null
): (reading: PluginUsageReading) => string | undefined {
  const pending = useRef(new Map<string, IconRequest>())
  const [sources, setSources] = useState(NO_ICONS)
  useEffect(() => {
    let current = true
    const requests = new Map(
      readings.flatMap(({ pluginKey, iconRevision }) =>
        iconRevision
          ? [
              [
                JSON.stringify([environmentId, pluginKey, iconRevision]),
                { pluginKey, revision: iconRevision }
              ] as const
            ]
          : []
      )
    )
    const target: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
    for (const key of pending.current.keys()) {
      if (!requests.has(key)) {
        pending.current.delete(key)
      }
    }
    // Share active and successful reads, and retry failed reads on a later quota refresh.
    void Promise.all(
      [...requests].map(async ([key, params]) => {
        let request = pending.current.get(key)
        if (!request || Date.now() >= request.retryAt) {
          const next: IconRequest = {
            retryAt: Infinity,
            source: callRuntimeRpc<{ base64: string } | null>(
              target,
              'plugins.readUsageIcon',
              params,
              { background: true, timeoutMs: 5_000 }
            )
              .then(imageSource)
              .catch(() => null)
              .then((source) => {
                if (!source) {
                  next.retryAt = Date.now() + ICON_RETRY_DELAY_MS
                }
                return source
              })
          }
          request = next
          pending.current.set(key, request)
        }
        return [key, await request.source] as const
      })
    ).then((entries) => {
      if (current) {
        setSources((previous) => {
          if (
            previous.size === entries.length &&
            entries.every(([key, src]) => previous.get(key) === src)
          ) {
            return previous
          }
          return new Map(entries)
        })
      }
    })
    return () => {
      current = false
    }
  }, [readings, environmentId])

  return ({ pluginKey, iconRevision }) =>
    iconRevision
      ? (sources.get(JSON.stringify([environmentId, pluginKey, iconRevision])) ?? undefined)
      : undefined
}
