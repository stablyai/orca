import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'

export function ChecksPanelLoadingAnnouncement({
  loading,
  reviewKey
}: {
  loading: boolean
  reviewKey: string
}): React.JSX.Element {
  const t = useTranslate()
  const [announcedReviewKey, setAnnouncedReviewKey] = useState<string | null>(null)
  useEffect(() => {
    if (!loading) {
      return
    }
    const timer = window.setTimeout(() => setAnnouncedReviewKey(reviewKey), 400)
    return () => {
      window.clearTimeout(timer)
      setAnnouncedReviewKey(null)
    }
  }, [loading, reviewKey])
  return (
    <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {loading && announcedReviewKey === reviewKey
        ? t('checksPanel.loadingReviewDetails', 'Loading review details…')
        : ''}
    </span>
  )
}
