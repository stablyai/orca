import { defineFixture } from '../../../component-fixtures/component-fixture'
import { RemoteViewportHeldChip } from './RemoteViewportHeldChip'

const HELD_LINES = [
  '$ pnpm test --watch',
  ' RUN  v5.0.5 /workspace/app',
  ' ✓ src/parser.test.ts (12 tests) 41ms',
  ' ✓ src/render.test.ts (8 tests) 33ms',
  ' Test Files  2 passed (2)',
  '      Tests  20 passed (20)'
]

export const held = defineFixture({
  width: 640,
  render: () => (
    <div className="relative h-48 overflow-hidden bg-background p-3">
      {/* Mimics a pane parked at a narrower grid owned by another window. */}
      <div className="w-[420px] border-r border-dashed border-border font-mono text-xs text-foreground">
        {HELD_LINES.map((line) => (
          <div key={line} className="whitespace-pre">
            {line}
          </div>
        ))}
      </div>
      <RemoteViewportHeldChip onFitHere={() => {}} />
    </div>
  )
})
