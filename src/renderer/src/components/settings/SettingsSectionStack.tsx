import type { ReactElement } from 'react'
import { Separator } from '../ui/separator'

// Key by section identity, not filtered index, so query edits cannot remount surviving sections and lose drafts or repeat loads.
export function SettingsSectionStack({
  sections,
  spacing
}: {
  sections: readonly (ReactElement | null)[]
  spacing: 'section' | 'group'
}): ReactElement {
  const visibleSections = sections.filter((section): section is ReactElement => section !== null)
  return (
    <>
      {visibleSections.map((section, index) => (
        <div key={section.key} className={spacing === 'group' ? 'space-y-8' : 'space-y-6'}>
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </>
  )
}
