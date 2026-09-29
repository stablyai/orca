import type { ReactElement } from 'react'
import { Separator } from '../ui/separator'

// Why: settings panes rebuild their section list from the search query, so a pane-local
// `key={index}` re-binds every key when an earlier section drops out. React then tears down
// and remounts each surviving section, discarding its unsaved drafts and re-issuing its
// loads once per keystroke. Keying by the section's own element key keeps a section that
// stays matched mounted for the whole search.
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
