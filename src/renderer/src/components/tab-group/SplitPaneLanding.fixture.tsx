import { defineFixture } from '../../component-fixtures/component-fixture'
import { SplitPaneLanding } from './SplitPaneLanding'

function Pane({ height = 440 }: { height?: number }): React.JSX.Element {
  return (
    <div className="relative" style={{ height }}>
      <SplitPaneLanding worktreeId="wt" groupId="g" autoFocus onClosePane={() => undefined} />
    </div>
  )
}

function typeQuery(frame: HTMLElement, value: string): void {
  const input = frame.querySelector<HTMLInputElement>('[cmdk-input]')
  if (!input) {
    return
  }
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

export const open = defineFixture({ width: 560, render: () => <Pane /> })

export const typing = defineFixture({
  width: 560,
  render: () => <Pane />,
  interact: (frame) => typeQuery(frame, 'mar')
})

export const noMatches = defineFixture({
  width: 560,
  render: () => <Pane />,
  interact: (frame) => typeQuery(frame, 'zzz')
})

export const narrow = defineFixture({ width: 260, render: () => <Pane /> })

export const card260 = defineFixture({ width: 324, render: () => <Pane /> })

// Why: the frame and pane padding plus the scroll gutter take 64px, so these cards are 288px (short placeholder, shortcuts kept) and 320px (full placeholder and shortcuts).
export const medium = defineFixture({ width: 352, render: () => <Pane /> })

export const mediumWide = defineFixture({ width: 384, render: () => <Pane /> })
