import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { DiffSectionHeader } from './DiffSectionHeader'

// Widths that cover each stage: everything fits, the folder gives way, counts drop, the name ellipsizes.
const DIFF_SECTION_HEADER_FIXTURE_WIDTHS = [520, 300, 240, 120] as const

export const narrowWidths = defineFixture({
  width: 560,
  render: () => (
    <div className="flex flex-col gap-2">
      {DIFF_SECTION_HEADER_FIXTURE_WIDTHS.map((width) => (
        <div key={width} data-testid={`diff-header-${width}`} style={{ width }}>
          <DiffSectionHeader
            path="docs/guides/release/release-checklist.md"
            dirty
            collapsed={false}
            added={12}
            removed={3}
            onToggle={() => {}}
            onOpenSection={() => {}}
            openSectionTitle="Open in editor"
            preview={{ target: 'markdown-preview', onOpen: () => {} }}
          />
        </div>
      ))}
    </div>
  )
})
