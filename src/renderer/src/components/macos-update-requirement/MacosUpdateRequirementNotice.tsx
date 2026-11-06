import { useEffect, useState, type JSX } from 'react'
import type { MacosUpgradeSupport } from '../../../../shared/macos-upgrade-support'
import type { UnsupportedSystemUpdate } from '../../../../shared/update-status-types'
import { openAppHttpLink } from '@/lib/app-http-link-open'
import { useAppStore } from '@/store'
import { MacosUpdateRequirementDialog } from './MacosUpdateRequirementDialog'

/** One-time notice when the updater withholds a release this Mac's macOS cannot run. */
export default function MacosUpdateRequirementNotice({
  requirement
}: {
  requirement: UnsupportedSystemUpdate
}): JSX.Element {
  const markSeen = useAppStore((s) => s.markMacosUpdateRequirementSeen)
  const [open, setOpen] = useState(true)
  const [support, setSupport] = useState<MacosUpgradeSupport>()
  const { minimumMacosVersion } = requirement

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api.app.getMacosUpgradeSupport?.(minimumMacosVersion))
      .catch(() => undefined)
      .then((result) => {
        if (!cancelled) {
          setSupport(result ?? 'unknown')
        }
      })
    return () => {
      cancelled = true
    }
  }, [minimumMacosVersion])

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) {
      markSeen(minimumMacosVersion)
    }
  }

  return (
    <MacosUpdateRequirementDialog
      open={open}
      onOpenChange={handleOpenChange}
      requirement={requirement}
      support={support}
      onOpenUrl={(url, event) => {
        handleOpenChange(false)
        openAppHttpLink(url, { event })
      }}
    />
  )
}
