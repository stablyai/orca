export const SESSION_RESUME_UNAVAILABLE_BANNER_TEXT =
  '--- previous session unavailable, started fresh ---'

type SessionRestoredBannerProps = {
  visible: boolean
}

// Only Orca's own fresh start is announced; a resume is confirmed by the agent's output.
export function SessionRestoredBanner({
  visible
}: SessionRestoredBannerProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }

  return <div className="session-restored-banner">{SESSION_RESUME_UNAVAILABLE_BANNER_TEXT}</div>
}
