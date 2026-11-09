import { useCallback, useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiAuditPage,
  CloudApiGrant,
  CloudApiKeyList,
  CloudApiMe,
  CloudApiSettings
} from '../../../../../shared/cloud-api/cloud-api-types'
import { CloudApiKeysView } from './CloudApiKeysView'
import { toCloudLoadState, type CloudLoadState } from './cloud-load-state'
import { CloudApiSignedOutNotice } from './CloudApiSignedOutNotice'
import { cloudApiErrorCopy } from './cloud-api-copy'
import { useOrcaCloudApiAvailability } from '@/hooks/useOrcaCloudApiAvailability'
import { useRequestGeneration } from './use-request-generation'

export function CloudApiKeysPane(): React.JSX.Element | null {
  const t = useTranslate()
  const availability = useOrcaCloudApiAvailability()
  const api = window.api.cloudApi
  const [viewer, setViewer] = useState<CloudApiMe | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [keys, setKeys] = useState<CloudLoadState<CloudApiKeyList>>({ status: 'loading' })
  const [settings, setSettings] = useState<CloudLoadState<CloudApiSettings>>({ status: 'loading' })
  const [grants, setGrants] = useState<CloudLoadState<CloudApiGrant[]>>({ status: 'loading' })
  const [audit, setAudit] = useState<CloudLoadState<CloudApiAuditPage>>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())
  const begin = useRequestGeneration()

  const word = useCallback(
    (failure: {
      error: Parameters<typeof cloudApiErrorCopy>[0]
      detail?: string
      retryAfterSeconds?: number
    }) => cloudApiErrorCopy(failure.error, t, failure),
    [t]
  )

  const load = useCallback(async (): Promise<void> => {
    if (!api) {
      return
    }
    const isCurrent = begin('page')
    // A page reload supersedes any in-flight list or grant refresh.
    begin('keys')
    begin('grants')
    setKeys({ status: 'loading' })
    setSettings({ status: 'loading' })
    setGrants({ status: 'loading' })
    const [me, list, current, apps] = await Promise.all([
      api.me(),
      api.listApiKeys(),
      api.getSettings(),
      api.listGrants()
    ])
    if (!isCurrent()) {
      return
    }
    setGrants(toCloudLoadState(apps.ok ? { ok: true, data: apps.data.grants } : apps, word))
    setSignedOut(!me.ok && me.error === 'signed-out')
    setViewer(me.ok ? me.data : null)
    // Without knowing who is looking, ownership labels and admin-only parts would be wrong:
    // surface the failure rather than a quietly degraded page.
    setKeys(
      me.ok || me.error === 'signed-out' ? toCloudLoadState(list, word) : toCloudLoadState(me, word)
    )
    setSettings(toCloudLoadState(current, word))
    setNow(Date.now())
  }, [api, begin, word])

  const loadAudit = useCallback(async (): Promise<void> => {
    if (!api) {
      return
    }
    const isCurrent = begin('audit')
    setAudit({ status: 'loading' })
    const result = await api.listAudit({ limit: 25 })
    if (isCurrent()) {
      setAudit(toCloudLoadState(result, word))
      setNow(Date.now())
    }
  }, [api, begin, word])

  useEffect(() => {
    if (availability?.status === 'ready') {
      void load()
    }
  }, [availability?.status, load])

  if (!api || availability?.status !== 'ready') {
    return null
  }
  if (signedOut) {
    return <CloudApiSignedOutNotice onRetry={() => void load()} />
  }
  return (
    <CloudApiKeysView
      controlPlaneUrl={availability.controlPlaneUrl}
      viewer={viewer}
      keys={keys}
      settings={settings}
      audit={
        viewer && viewer.role !== 'member' && viewer.scopes.includes('audit:read') ? audit : null
      }
      now={now}
      onRefresh={() => void load()}
      onCreate={async (input) => {
        const result = await api.createApiKey(input)
        if (result.ok) {
          // Refresh the list behind the dialog; the secret stays only in the dialog's state.
          const isCurrent = begin('keys')
          void api.listApiKeys().then((next) => {
            if (isCurrent()) {
              setKeys(toCloudLoadState(next, word))
            }
          })
        }
        return result
      }}
      onRevoke={async (key) => {
        const result = await api.revokeApiKey(key.id)
        if (!result.ok && result.error !== 'not-found') {
          return word(result)
        }
        setKeys((current) =>
          current.status === 'ok'
            ? {
                status: 'ok',
                data: { ...current.data, keys: current.data.keys.filter((k) => k.id !== key.id) }
              }
            : current
        )
        return null
      }}
      onToggleVmCli={async (vmCliEnabled) => {
        const result = await api.putSettings({ vmCliEnabled })
        if (!result.ok) {
          return word(result)
        }
        setSettings({ status: 'ok', data: result.data })
        return null
      }}
      onLoadAudit={() => void loadAudit()}
      onCreateApproval={(input) => api.createApproval(input)}
      grants={grants}
      onRefreshGrants={() => {
        const isCurrent = begin('grants')
        setGrants({ status: 'loading' })
        void api.listGrants().then((apps) => {
          if (isCurrent()) {
            setGrants(toCloudLoadState(apps.ok ? { ok: true, data: apps.data.grants } : apps, word))
          }
        })
      }}
      onRevokeGrant={async (grant) => {
        const result = await api.revokeGrant(grant.id)
        if (!result.ok && result.error !== 'not-found') {
          return word(result)
        }
        setGrants((current) =>
          current.status === 'ok'
            ? { status: 'ok', data: current.data.filter((g) => g.id !== grant.id) }
            : current
        )
        return null
      }}
    />
  )
}
