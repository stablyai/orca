import { useRef, useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NativeChatPromptEditor } from './composer/editor/NativeChatPromptEditor'
import type { NativeChatComposerInput } from './composer/editor/native-chat-composer-input'
import { NativeChatTextDirectionPicker } from './composer/controls/NativeChatTextDirectionPicker'
import { NativeChatQuestionCard } from './prompts/NativeChatQuestionCard'
import { SessionInlineDetails } from '../right-sidebar/ai-vault/session-list/AiVaultSessionDetails'
import { AiVaultSearchEvidence } from '../right-sidebar/ai-vault/search/AiVaultSearchEvidence'
import { VaultSessionRow } from '../right-sidebar/ai-vault/session-list/AiVaultSessionRow'
import type { AiVaultSession } from '../../../../shared/ai-vault/contracts/ai-vault-types'

const LONG_PERSIAN =
  'سلام؛ متن فارسی و English را در کادر تایپ می‌کنم تا جهت و ترتیب واژه‌ها در خط‌های شکسته درست بماند. '.repeat(
    4
  )
const SHORT_PERSIAN = 'این پیش‌نمایش فارسی با Orca ترکیب شده است.'
const noop = (): void => {}

function Composer(): React.JSX.Element {
  const input = useRef<NativeChatComposerInput>(null)
  const [direction, setDirection] = useState<'auto' | 'ltr' | 'rtl'>('auto')
  return (
    <div data-bidi-composer className="rounded-xl border border-chat-composer-border p-3">
      <NativeChatPromptEditor
        inputRef={input}
        initialValue={`${LONG_PERSIAN}\nHello, this paragraph stays on the left.\nOh, ${LONG_PERSIAN}`}
        disabled={false}
        placeholder="Ask anything"
        textDirection={direction}
        onChange={noop}
        onSelect={noop}
        className="w-full text-sm outline-none"
      />
      <NativeChatTextDirectionPicker
        value={direction}
        onChange={setDirection}
        focusComposer={() => input.current?.focus()}
      />
    </div>
  )
}

const session: AiVaultSession = {
  id: 'bidi-fixture',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'bidi-fixture',
  title: 'گفتگوی فارسی در Orca',
  titleKind: 'named',
  cwd: '/project',
  branch: 'master',
  model: null,
  filePath: '/project/session.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-01-01T00:00:00Z',
  messageCount: 1,
  totalTokens: 0,
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  previewMessages: [{ role: 'assistant', text: SHORT_PERSIAN, timestamp: null }],
  resumeCommand: 'codex resume bidi-fixture',
  subagent: null
}

function HistoryRow({ value }: { value: AiVaultSession }): React.JSX.Element {
  const startup = { command: value.resumeCommand }
  return (
    <VaultSessionRow
      session={value}
      liveState={null}
      resumeStartup={startup}
      realHomeResumeStartup={startup}
      worktreeInfo={null}
      vaultScope="all"
      detailsExpanded={false}
      resumeDisabled
      onToggleDetails={noop}
      showJumpToWorktree={false}
      onResume={noop}
      resumeLabel="Resume"
      resumeActions={{
        worktree: { worktreeId: null, disabled: true },
        newTab: { worktreeId: null, disabled: true }
      }}
      onResumeInWorktree={noop}
      onResumeInNewTab={noop}
      onCopyId={noop}
      onPick={noop}
    />
  )
}

function Surfaces(): React.JSX.Element {
  return (
    <div className="native-chat-appearance space-y-4 bg-chat-canvas p-4">
      <Composer />
      <div data-bidi-question>
        <NativeChatQuestionCard
          prompt={{
            questions: [
              {
                question: 'برای متن فارسی و English کدام جهت را می‌خواهی؟',
                multiSelect: false,
                options: [
                  {
                    label: 'متن فارسی با Unicode باید درست دیده شود.',
                    description: 'توضیح فارسی با Orca در یک جمله.'
                  },
                  { label: 'English stays left aligned.' }
                ]
              }
            ]
          }}
          onAnswer={noop}
          onCancel={noop}
          shouldFocus={false}
        />
      </div>
      <div data-bidi-history>
        <HistoryRow value={session} />
      </div>
    </div>
  )
}

function assertLastLineSide(element: Element, direction: 'ltr' | 'rtl'): void {
  const range = document.createRange()
  range.selectNodeContents(element)
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0
  )
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  const line = rects.filter((rect) => Math.abs(rect.bottom - bottom) < 2)
  const block = element.getBoundingClientRect()
  const gap =
    direction === 'rtl'
      ? block.right - Math.max(...line.map((rect) => rect.right))
      : Math.min(...line.map((rect) => rect.left)) - block.left
  if (Math.abs(gap) > 3) {
    throw new Error(`Last line must align ${direction}: gap=${gap}, ${element.textContent}`)
  }
}

export const preview = defineFixture({ width: 560, render: () => <Surfaces /> })

export const bidi = defineFixture({
  width: 560,
  render: () => <Surfaces />,
  interact: (frame) => {
    const paragraphs = frame.querySelectorAll(
      '[data-bidi-composer] [data-native-chat-prompt-editor] p'
    )
    paragraphs.forEach((p, index) => assertLastLineSide(p, index === 0 ? 'rtl' : 'ltr'))
    const option = frame.querySelector('[data-bidi-question] button[aria-pressed] [dir="auto"]')!
    assertLastLineSide(option, 'rtl')
    const history = frame.querySelectorAll('[data-bidi-history] [dir="auto"]')
    history.forEach((text) => assertLastLineSide(text, 'rtl'))
    if (history.length !== 2 || paragraphs.length !== 3) {
      throw new Error('Missing BiDi surfaces')
    }
  }
})

const REPORT_MESSAGES = [
  'این یک متن آزمایشی فارسی است که نام Orca و واژه‌های English را در میان جمله‌ها قرار می‌دهد. پرانتزهای (Light) و (Dark)، اعداد ۱۲۳ و نشانه‌های نگارشی باید خوانا بمانند.\n\nبرای بررسی یک پاراگراف مستقل، عبارت Build را کنار متن فارسی می‌نویسیم. این خط باید بدون جابه‌جایی کلمات در سمت راست قرار بگیرد.\n\nدر یک نمونه طولانی‌تر، واژه‌های PR و Issue و (Pull Request) نیز میان متن فارسی دیده می‌شوند. هدف این نمونه بررسی شکستن سطرها در کادر باریک و نمایش درست پایان جمله است.',
  'این نمونه برای آزمایش عبارت (Code Checks) و متن ترکیبی طراحی شده است. اعداد ۳۲ و ۱۲۳ در کنار کلمات فارسی و English قرار می‌گیرند تا ترتیب نمایش آن‌ها بررسی شود.\n\nنام Orca در کنار اصطلاح Profile می‌آید تا ترتیب واژه‌های انگلیسی در یک جملهٔ فارسی سنجیده شود. این پاراگراف عمداً طولانی نوشته شده تا چند سطر بسازد.\n\nدر پایان، نام Electron و یک عبارت فارسی در کنار هم قرار می‌گیرند. نمایش این متن باید در حالت روشن و تیره قابل خواندن باشد و نشانهٔ پایان جمله در جای درست قرار بگیرد.',
  'مرحباً؛ تعمل نسخة Orca مع العربية وEnglish بشكل صحيح.',
  'English remains left aligned, including Persian words مثل فارسی.',
  'سلام Orca؛ آماده است.\nEnglish paragraph stays left.\nمرحبا بالعالم مع Orca.'
]

function HistoryDetails(): React.JSX.Element {
  return (
    <div className="space-y-4 bg-background p-4">
      {REPORT_MESSAGES.map((text, index) => (
        <section key={text} data-history-sample={index}>
          <div data-history-collapsed>
            <HistoryRow
              value={{
                ...session,
                previewMessages: [{ role: 'assistant', text, timestamp: null }]
              }}
            />
          </div>
          <SessionInlineDetails
            id={`bidi-details-${index}`}
            session={{
              ...session,
              filePath: '',
              firstUserPrompt: text,
              previewMessages: [
                { role: index % 2 === 0 ? 'user' : 'assistant', text, timestamp: null }
              ]
            }}
            worktreeInfo={null}
            vaultScope="all"
            resumeActions={{
              worktree: { worktreeId: null, disabled: true },
              newTab: { worktreeId: null, disabled: true }
            }}
            onResumeInWorktree={noop}
            onResumeInNewTab={noop}
            actionsHidden
          />
          <AiVaultSearchEvidence
            hit={{
              accountHome: null,
              agent: 'codex',
              sessionId: session.sessionId,
              title: session.title,
              cwd: null,
              branch: null,
              updatedAt: null,
              messageCount: 1,
              score: 1,
              source: { presence: 'present' },
              evidence: { role: 'assistant', snippet: `[[${text}]]`, timestamp: null }
            }}
          />
        </section>
      ))}
    </div>
  )
}

function assertHistory(frame: HTMLElement): void {
  for (const sample of frame.querySelectorAll('[data-history-sample]')) {
    const index = Number(sample.getAttribute('data-history-sample'))
    const paragraphs = sample.querySelectorAll('p.select-text')
    if (paragraphs.length !== 2) {
      throw new Error('Missing first prompt or expanded turn')
    }
    for (const paragraph of paragraphs) {
      if (paragraph.textContent !== REPORT_MESSAGES[index]) {
        throw new Error('History text changed')
      }
      assertVisibleParagraphs(paragraph, index === 3 ? 'ltr' : 'rtl')
    }
    const snippet = sample.querySelector('mark')!.parentElement!
    assertVisibleParagraphs(snippet, index === 3 ? 'ltr' : 'rtl')
    const label = snippet.querySelector('bdi')
    if (!label) {
      throw new Error('Search role label must be isolated from message direction')
    }
    assertRoleSeparator(label, index === 3 ? 'ltr' : 'rtl')
    const collapsedLabel = sample.querySelector('[data-history-collapsed] bdi')!
    assertRoleSeparator(collapsedLabel, index === 3 ? 'ltr' : 'rtl')
  }
}

function assertVisibleParagraphs(element: Element, firstDirection: 'ltr' | 'rtl'): void {
  const block = element.getBoundingClientRect()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('bdi')) {
      continue
    }
    const text = node.textContent ?? ''
    let offset = 0
    for (const paragraph of text.split('\n')) {
      if (paragraph.trim()) {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + paragraph.length)
        const rects = Array.from(range.getClientRects()).filter(
          (rect) => rect.width > 0 && rect.bottom <= block.bottom + 2 && rect.top >= block.top - 2
        )
        if (rects.length) {
          const bottom = Math.max(...rects.map((rect) => rect.bottom))
          const labelRects = Array.from(element.querySelector('bdi')?.getClientRects() ?? [])
          const last = [...rects, ...labelRects].filter(
            (rect) => Math.abs(rect.bottom - bottom) < 2
          )
          const direction = paragraph.startsWith('English') ? 'ltr' : firstDirection
          const gap =
            direction === 'rtl'
              ? block.right - Math.max(...last.map((rect) => rect.right))
              : Math.min(...last.map((rect) => rect.left)) - block.left
          if (Math.abs(gap) > 4) {
            throw new Error(`History paragraph ${direction} gap=${gap}: ${paragraph}`)
          }
        }
      }
      offset += paragraph.length + 1
    }
  }
}

export const historyNarrow = defineFixture({
  width: 360,
  render: () => <HistoryDetails />,
  interact: assertHistory
})
export const historyWide = defineFixture({
  width: 640,
  render: () => <HistoryDetails />,
  interact: assertHistory
})

function assertRoleSeparator(label: Element, direction: 'ltr' | 'rtl'): void {
  const separator = label.nextSibling
  if (
    !separator ||
    separator.nodeType !== Node.TEXT_NODE ||
    !separator.textContent?.startsWith(':')
  ) {
    throw new Error('Role separator must follow the paragraph direction outside the isolated label')
  }
  const range = document.createRange()
  range.setStart(separator, 0)
  range.setEnd(separator, 1)
  const colon = range.getBoundingClientRect()
  const role = label.getBoundingClientRect()
  const gap = direction === 'rtl' ? role.left - colon.right : colon.left - role.right
  if (Math.abs(gap) > 1) {
    throw new Error(`Role separator must adjoin the ${direction} trailing edge: gap=${gap}`)
  }
}

export const historyPreview = defineFixture({ width: 640, render: () => <HistoryDetails /> })
