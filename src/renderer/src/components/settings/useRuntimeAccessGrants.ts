import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { translate } from '@/i18n/i18n'

type UseRuntimeAccessGrantsResult = {
  grants: RuntimeAccessGrant[]
  isLoading: boolean
  revokingGrantId: string | null
  reload: (options?: { showToastOnError?: boolean }) => Promise<void>
  revoke: (grant: RuntimeAccessGrant) => Promise<void>
}

export function useRuntimeAccessGrants(args: {
  onGrantRevoked: (deviceId: string) => void
}): UseRuntimeAccessGrantsResult {
  const [grants, setGrants] = useState<RuntimeAccessGrant[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null)
  const loadIdRef = useRef(0)
  const mountedRef = useMountedRef()
  const onGrantRevokedRef = useRef(args.onGrantRevoked)
  onGrantRevokedRef.current = args.onGrantRevoked

  const reload = useCallback(
    async (options: { showToastOnError?: boolean } = {}): Promise<void> => {
      const loadId = loadIdRef.current + 1
      loadIdRef.current = loadId
      if (mountedRef.current) {
        setIsLoading(true)
      }
      try {
        const result = await window.api.mobile.listRuntimeAccessGrants()
        if (mountedRef.current && loadId === loadIdRef.current) {
          setGrants(result.grants)
        }
      } catch (error) {
        if (mountedRef.current && loadId === loadIdRef.current && options.showToastOnError) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.1b4e0bbcc5',
                  'Failed to load shared access grants.'
                )
          )
        }
      } finally {
        if (mountedRef.current && loadId === loadIdRef.current) {
          setIsLoading(false)
        }
      }
    },
    [mountedRef]
  )

  const revoke = useCallback(
    async (grant: RuntimeAccessGrant): Promise<void> => {
      setRevokingGrantId(grant.deviceId)
      try {
        const result = await window.api.mobile.revokeRuntimeAccess({ deviceId: grant.deviceId })
        if (!result.revoked) {
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.settings.RuntimePairingUrlGenerator.d797f516b1',
                'Shared access was already revoked.'
              )
            )
          }
          await reload()
          return
        }
        if (mountedRef.current) {
          // Invalidate any reload still in flight; its pre-revocation list would write the
          // revoked grant back. Clearing isLoading here because that load's finally no longer can.
          loadIdRef.current += 1
          setIsLoading(false)
          setGrants((current) => current.filter((entry) => entry.deviceId !== grant.deviceId))
        }
        onGrantRevokedRef.current(grant.deviceId)
        if (mountedRef.current) {
          toast.success(
            translate(
              'auto.components.settings.RuntimePairingUrlGenerator.9f8e037c4a',
              'Shared access revoked.'
            )
          )
        }
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate(
                  'auto.components.settings.RuntimePairingUrlGenerator.e8d83f2b0f',
                  'Failed to revoke shared access.'
                )
          )
        }
      } finally {
        if (mountedRef.current) {
          setRevokingGrantId(null)
        }
      }
    },
    [mountedRef, reload]
  )

  useEffect(() => {
    void reload()
    return () => {
      loadIdRef.current += 1
    }
  }, [reload])

  return { grants, isLoading, revokingGrantId, reload, revoke }
}
