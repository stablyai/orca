import { useEffect, useState, type JSX } from 'react'
import type { MacosUpgradeSupport } from '../../../../../shared/macos-12-support-notice/upgrade-support'
import { openAppHttpLink } from '@/lib/app-http-link-open'
import { MacosSupportNoticeDialog } from './MacosSupportNoticeDialog'

export function MacosSupportNoticeTip({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const [support, setSupport] = useState<MacosUpgradeSupport | null>()

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(window.api.app.getMacosUpgradeSupport?.())
      .then((result) => {
        if (!cancelled) {
          setSupport(result ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSupport(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <MacosSupportNoticeDialog
      open={open}
      onOpenChange={onOpenChange}
      support={support}
      onOpenUrl={(url, event) => {
        onOpenChange(false)
        openAppHttpLink(url, { event })
      }}
    />
  )
}
