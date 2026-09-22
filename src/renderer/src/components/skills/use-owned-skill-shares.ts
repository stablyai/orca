import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { SkillCloudOwnedShare } from '../../../../shared/skill-cloud-contract'
import { translate } from '@/i18n/i18n'

function inventoryError(status: string): string {
  return status === 'reconnect-required'
    ? translate(
        'auto.components.settings.shareSkills.linksReconnect',
        'Sign in again to manage shared links.'
      )
    : translate(
        'auto.components.settings.shareSkills.linksUnavailable',
        'Shared links are unavailable right now.'
      )
}

export type OwnedSkillShares = {
  shares: SkillCloudOwnedShare[]
  loading: boolean
  error: string | null
  busyShareId: string | null
  refresh: () => void
  revoke: (share: SkillCloudOwnedShare) => Promise<void>
}

export function useOwnedSkillShares(): OwnedSkillShares {
  const [shares, setShares] = useState<SkillCloudOwnedShare[]>([])
  const [loading, setLoading] = useState(true)
  const [busyShareId, setBusyShareId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const operation = await window.api.skills.listOwnedShares()
      if (generation.current !== current) {
        return
      }
      if (operation.status !== 'ok') {
        setError(inventoryError(operation.status))
        return
      }
      setShares(operation.value)
    } catch {
      if (generation.current === current) {
        setError(inventoryError('unavailable'))
      }
    } finally {
      if (generation.current === current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      generation.current += 1
    }
  }, [load])

  const revoke = useCallback(async (share: SkillCloudOwnedShare): Promise<void> => {
    setBusyShareId(share.id)
    setError(null)
    try {
      const operation = await window.api.skills.revokeShare(share.id)
      if (operation.status !== 'ok') {
        setError(inventoryError(operation.status))
        return
      }
      setShares((current) => current.filter((candidate) => candidate.id !== share.id))
      toast.success(translate('auto.components.settings.shareSkills.linkRevoked', 'Link revoked'))
    } catch {
      setError(
        translate(
          'auto.components.settings.shareSkills.revokeFailed',
          'Orca could not revoke this link.'
        )
      )
    } finally {
      setBusyShareId(null)
    }
  }, [])

  return {
    shares,
    loading,
    error,
    busyShareId,
    refresh: () => void load(),
    revoke
  }
}
