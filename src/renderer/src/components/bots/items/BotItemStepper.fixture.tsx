import { useEffect, useRef, useState } from 'react'
import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { BotItemCommentBox } from './BotItemCommentBox'
import { BotItemNavRow, BotItemStepper } from './BotItemStepper'

const item = makeTestBotItem(7, { title: 'Fix the share dialog' })
const NO_STEP = (): void => {}

/** The comment box with its arrows, in an item pane `width` wide (the arrows' container). */
function Row({
  width,
  total,
  attach,
  loading = false,
  placeholder = false,
  onStep = NO_STEP
}: {
  width: number
  total: number
  attach: boolean
  loading?: boolean
  placeholder?: boolean
  onStep?: () => void
}): React.JSX.Element {
  const pane = useRef<HTMLDivElement | null>(null)
  const place = { index: total - 2, total }
  const nav = (
    <BotItemStepper
      pane={pane}
      place={place}
      loading={loading}
      offline={false}
      canStep={() => !loading}
      onStep={onStep}
    />
  )
  return (
    <div ref={pane} className="@container/item-pane flex flex-col" style={{ width }}>
      {placeholder ? (
        <BotItemNavRow nav={nav} />
      ) : (
        <BotItemCommentBox
          bot={fixtureCos}
          item={item}
          attachTo={
            attach
              ? {
                  worktreeId: folderWorkspaceKey(fixtureCos.folderWorkspaceId),
                  runtimeEnvironmentId: null
                }
              : null
          }
          onSend={() => {}}
          nav={nav}
        />
      )}
    </div>
  )
}

function row(width: number, total: number, attach: boolean): ComponentFixture {
  return defineFixture({
    width: width + 32,
    render: () => <Row width={width} total={total} attach={attach} />
  })
}

export const w220short = row(220, 105, false)
export const w220shortAttach = row(220, 105, true)
export const w220long = row(220, 1204, false)
export const w220longAttach = row(220, 1204, true)
export const w260short = row(260, 105, false)
export const w260shortAttach = row(260, 105, true)
export const w260long = row(260, 1204, false)
export const w260longAttach = row(260, 1204, true)
export const w300short = row(300, 105, false)
export const w300shortAttach = row(300, 105, true)
export const w300long = row(300, 1204, false)
export const w300longAttach = row(300, 1204, true)
export const w340short = row(340, 105, false)
export const w340shortAttach = row(340, 105, true)
export const w340long = row(340, 1204, false)
export const w340longAttach = row(340, 1204, true)

/** A page read that has lasted: the spinner takes the counter's place, or Next's where the counter is hidden. */
export const loadingWide = defineFixture({
  width: 372,
  render: () => <Row width={340} total={105} attach loading />
})
export const loadingNarrow = defineFixture({
  width: 252,
  render: () => <Row width={220} total={105} attach loading />
})

/** No comment box (deleted, or not read yet): the arrows where the box's sit. */
export const placeholder = defineFixture({
  width: 332,
  render: () => <Row width={300} total={105} attach={false} placeholder />
})

/** The item is deleted: the box gives way to its placeholder row after 600ms. Each arrow activation counts on
 *  `data-steps`, for a hit-and-click check across the swap. */
function Swap(): React.JSX.Element {
  const [deleted, setDeleted] = useState(false)
  const [steps, setSteps] = useState(0)
  useEffect(() => {
    const timer = window.setTimeout(() => setDeleted(true), 600)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div data-steps={steps} className="relative flex h-[300px] flex-col justify-end">
      <Row
        width={300}
        total={105}
        attach={false}
        placeholder={deleted}
        onStep={() => setSteps((count) => count + 1)}
      />
    </div>
  )
}
export const deleteSwap = defineFixture({ width: 332, render: () => <Swap /> })

/** A 280px pane with + and a four-digit place (the counter doesn't fit): a page read starts at 1.5s and lands
 *  at 3s, for a check that loading shows on Next, not in the counter's slot, and resets after. */
function LoadingCycle(): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const start = window.setTimeout(() => setLoading(true), 1500)
    const end = window.setTimeout(() => setLoading(false), 3000)
    return () => {
      window.clearTimeout(start)
      window.clearTimeout(end)
    }
  }, [])
  return <Row width={280} total={1204} attach loading={loading} />
}
export const loadingCycle = defineFixture({ width: 312, render: () => <LoadingCycle /> })
