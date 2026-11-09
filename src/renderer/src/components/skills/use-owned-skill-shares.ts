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
  /** Package whose links are being stopped; its row stays busy until every stop settles. */
  busyPackageId: string | null
  refresh: () => void
  revoke: (share: SkillCloudOwnedShare) => Promise<void>
  /** Stops several links of one package, then names any that are still live. */
  revokeMany: (shares: SkillCloudOwnedShare[]) => Promise<void>
}

export function useOwnedSkillShares(): OwnedSkillShares {
  const [shares, setShares] = useState<SkillCloudOwnedShare[]>([])
  const [loading, setLoading] = useState(true)
  const [busyPackageId, setBusyPackageId] = useState<string | null>(null)
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

  const revokeMany = useCallback(async (targets: SkillCloudOwnedShare[]): Promise<void> => {
    setBusyPackageId(targets[0]?.packageId ?? null)
    setError(null)
    const stopped = new Set<string>()
    let failure: string | null = null
    for (const share of targets) {
      try {
        const operation = await window.api.skills.revokeShare(share.id)
        if (operation.status !== 'ok') {
          failure = inventoryError(operation.status)
          break
        }
        stopped.add(share.id)
      } catch {
        failure ??= translate(
          'auto.components.settings.shareSkills.revokeFailed',
          'Orca could not revoke this link.'
        )
      }
    }
    // Why: removing rows mid-sequence would change the row's identity and re-enable its stops.
    setShares((current) => current.filter((candidate) => !stopped.has(candidate.id)))
    setBusyPackageId(null)
    const live = targets.filter((share) => !stopped.has(share.id))
    if (live.length === 0) {
      toast.success(translate('auto.components.settings.shareSkills.linkRevoked', 'Link revoked'))
      return
    }
    const stillLive = translate(
      'auto.components.settings.shareSkills.stillLive',
      'Still live: {{links}}',
      {
        links: live.map((share) => share.url).join(', ')
      }
    )
    setError(failure ? `${failure} ${stillLive}` : stillLive)
  }, [])
  const revoke = useCallback(
    (share: SkillCloudOwnedShare): Promise<void> => revokeMany([share]),
    [revokeMany]
  )

  return {
    shares,
    loading,
    error,
    busyPackageId,
    refresh: () => void load(),
    revoke,
    revokeMany
  }
}
