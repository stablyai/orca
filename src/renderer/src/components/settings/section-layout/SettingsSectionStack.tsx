import type { ReactElement } from 'react'

// Render sections by their own keys, not filtered index, so query edits cannot remount surviving sections and lose drafts or repeat loads.
export function SettingsSectionStack({
  sections
}: {
  sections: readonly (ReactElement | null)[]
}): ReactElement {
  return <div className="space-y-8">{sections.filter((section) => section !== null)}</div>
}
