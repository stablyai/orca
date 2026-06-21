export const SESSION_RESTORED_BANNER_TEXT = '--- session restored ---'

type SessionRestoredBannerProps = {
  visible: boolean
}

export function SessionRestoredBanner({
  visible
}: SessionRestoredBannerProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }

  return <div className="session-restored-banner">{SESSION_RESTORED_BANNER_TEXT}</div>
}
