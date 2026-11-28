import { SettingsBadge } from './SettingsFormControls'

export function SettingsTitleWithBadge({
  title,
  badge,
  children
}: {
  title: React.ReactNode
  badge?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className="leading-snug">
      {title}
      {badge ? <SettingsBadge className="ml-2 align-middle">{badge}</SettingsBadge> : null}
      {children}
    </span>
  )
}
