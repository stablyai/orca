import { useEffect, useRef, useState } from 'react'
import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { BotItemCommentBox } from './BotItemCommentBox'
import { BotItemNavRow, BotItemStepper } from './BotItemStepper'
import type { BotItemWaitingQuestion } from './BotItemReplyingTo'
import { botRefKey } from '@/lib/bot-hosts'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'

const item = makeTestBotItem(7, { title: 'Fix the share dialog' })
const NO_STEP = (): void => {}

/** The comment box with its arrows, in an item pane `width` wide (the arrows' container). */
function Row({
  width,
  total,
  attach,
  loading = false,
  placeholder = false,
  question = null,
  onStep = NO_STEP
}: {
  width: number
  total: number
  attach: boolean
  loading?: boolean
  placeholder?: boolean
  question?: BotItemWaitingQuestion | null
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
          onSend={() => null}
          nav={nav}
          question={question}
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

/** A pane `width` wide (desktop-wide by default) with typed text: lines use the box's full width, the
 *  controls sit below them. */
function typed(text: string, width = 1248, total = 219): ComponentFixture {
  return defineFixture({
    width: width + 32,
    setup: () =>
      updateNativeChatComposerDraft(
        `bot-item-comment:${botRefKey(fixtureCos)}:${item.uid}`,
        { text, images: [] },
        'immediate'
      ),
    render: () => <Row width={width} total={total} attach />
  })
}
export const wideUnbroken = typed('g'.repeat(400))
/** One line under the 520px break, with arrows: it starts as far below the border as chat's composer text. */
export const stackedOneLine = typed('Yes, merge it once CI is green', 420, 3)
export const wideLines = typed(
  'Link expiry should default to 7 days, with a picker for 1 day, 30 days and never; owners can change it after sharing.\nResharing stays with editors.\nShip it behind the existing sharing flag.'
)

const ASK: BotItemWaitingQuestion = {
  id: 'ask:0',
  eventId: 'ask',
  line: 'After reviewing the explainer, may I merge #48120 once CI is green?',
  replies: true,
  asker: 'CoS'
}

const paint = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** Switches the frame to `locale` from the saved preference, as the app does. */
async function switchLocale(locale: 'en' | 'tr' | 'zh'): Promise<void> {
  await loadRendererUiLanguage(locale)
  useAppStore.setState(({ settings }) =>
    settings ? { settings: { ...settings, uiLanguage: locale } } : {}
  )
  for (let attempt = 0; i18n.language !== locale && attempt < 120; attempt++) {
    await paint()
  }
  await paint()
  await paint()
}

/** The agent's question waiting, in a pane `width` wide, with `text` typed, at item `total - 2` of `total`. */
function asking(
  width: number,
  {
    text = '',
    total = 13,
    locale,
    question = ASK
  }: {
    text?: string
    total?: number
    locale?: 'en' | 'tr' | 'zh'
    question?: BotItemWaitingQuestion
  } = {}
): ComponentFixture {
  return defineFixture({
    width: width + 32,
    setup: () =>
      updateNativeChatComposerDraft(
        `bot-item-comment:${botRefKey(fixtureCos)}:${item.uid}`,
        { text, images: [] },
        'immediate'
      ),
    render: () => <Row width={width} total={total} attach question={question} />,
    interact: async () => switchLocale(locale ?? 'en')
  })
}
const ASK_LONG =
  'Yes, merge it once CI is green and the review has passed on the latest commit. Also add the screenshots to the PR description before you do. Thanks!'
export const askWide = asking(560)
export const askMid = asking(340)
export const askNarrow = asking(220)
export const askBreak = asking(519)
export const askAboveBreak = asking(520)
export const askLong = asking(560, { text: ASK_LONG })
export const askLongNarrow = asking(260, { text: ASK_LONG })
export const askVeryLong = asking(560, { text: Array(6).fill(ASK_LONG).join('\n') })
export const askEn520ThreeDigits = asking(520, { total: 105 })
export const askEn520FourDigits = asking(520, { total: 1204 })
export const askTr440 = asking(440, { locale: 'tr' })
export const askTr480 = asking(480, { locale: 'tr' })
export const askTr520 = asking(520, { locale: 'tr', total: 105 })
export const askZh440 = asking(440, { locale: 'zh' })
export const askZh480 = asking(480, { locale: 'zh' })
export const askZh520 = asking(520, { locale: 'zh', total: 105 })

/** A question without quick replies, from a bot with a long name: "Reply to <name>…". */
const OPEN_ASK: BotItemWaitingQuestion = {
  ...ASK,
  replies: false,
  asker: 'Design Review Assistant'
}
export const openAskEn520 = asking(520, { question: OPEN_ASK, total: 1204 })
export const openAskEn560 = asking(560, { question: OPEN_ASK, total: 1204 })
export const openAskTr520 = asking(520, { question: OPEN_ASK, locale: 'tr' })
export const openAskTr560 = asking(560, { question: OPEN_ASK, locale: 'tr', total: 105 })
export const openAskZh520 = asking(520, { question: OPEN_ASK, locale: 'zh' })
export const openAskZh560 = asking(560, { question: OPEN_ASK, locale: 'zh', total: 1204 })
export const openAskEn760 = asking(760, { question: OPEN_ASK, total: 1204 })

/** Opened in a 400px pane (stacked), then widened to 800px: the box comes back to one row. */
export const askWidens = defineFixture({
  ...asking(400),
  width: 832,
  interact: async (frame) => {
    await switchLocale('en')
    frame.querySelector<HTMLElement>('[style*="width"]')?.style.setProperty('width', '800px')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

/** Opened at 800px with a two-line draft (stacked), then emptied: the box comes back to one row. */
export const askDraftCleared = defineFixture({
  ...asking(800, { text: 'First line\nSecond line' }),
  width: 832,
  interact: async (frame) => {
    await switchLocale('en')
    const editor = frame.querySelector<HTMLElement>('[contenteditable="true"]')
    editor?.focus()
    document.execCommand('selectAll')
    document.execCommand('delete')
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})
