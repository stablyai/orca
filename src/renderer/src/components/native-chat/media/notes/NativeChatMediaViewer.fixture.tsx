import { useLayoutEffect, useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { registerNativeChatComposerDestination } from '../../composer/focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'
import { NativeChatMediaViewer } from './NativeChatMediaViewer'
import type { NativeChatMediaNote } from './native-chat-media-notes'

const card = (x: number, y: number, fill: string): string =>
  [
    `<rect x="${x}" y="${y}" width="300" height="180" rx="14" fill="${fill}"/>`,
    `<rect x="${x + 24}" y="${y + 28}" width="160" height="16" rx="8" fill="#cbd5e1"/>`,
    `<rect x="${x + 24}" y="${y + 62}" width="220" height="44" rx="8" fill="#e2e8f0"/>`
  ].join('')

// A seeded sample dashboard, drawn here so the shot needs no files or network.
const sample = (width: number, height: number): string =>
  `data:image/svg+xml,${encodeURIComponent(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1200 760">`,
      '<rect width="1200" height="760" fill="#f8fafc"/>',
      '<rect width="1200" height="72" fill="#1e293b"/>',
      '<rect x="32" y="24" width="180" height="24" rx="6" fill="#64748b"/>',
      card(40, 120, '#ffffff'),
      card(370, 140, '#ffffff'),
      card(700, 120, '#ffffff'),
      '<rect x="40" y="360" width="960" height="320" rx="14" fill="#ffffff"/>',
      '<polyline points="80,620 220,540 360,580 500,470 640,500 780,420 920,450" fill="none" stroke="#3b82f6" stroke-width="6"/>',
      '</svg>'
    ].join('')
  )}`
const SAMPLE = sample(1200, 760)

const NOTES: NativeChatMediaNote[] = [
  {
    id: 'n1',
    number: 1,
    text: 'Align this card with the other two',
    mark: { kind: 'pin', x: 0.43, y: 0.2 }
  },
  {
    id: 'n2',
    number: 2,
    text: 'The chart line is too thin to read',
    mark: { kind: 'box', x: 0.05, y: 0.52, width: 0.78, height: 0.36 }
  },
  { id: 'n3', number: 3, text: 'Use the product name here', mark: { kind: 'pin', x: 0.1, y: 0.05 } }
]

const opener = { current: null }

export const viewing = defineFixture({
  width: 1280,
  render: () => (
    <NativeChatMediaViewer
      open
      onOpenChange={() => {}}
      src={SAMPLE}
      title="dashboard.png"
      source={{ path: '/tmp/dashboard.png' }}
      opener={opener}
      onPrevious={null}
      onNext={() => {}}
      position={{ index: 0, count: 3 }}
    />
  )
})

const composerFor = (
  blocked: ReturnType<NonNullable<NativeChatComposerHandle['notesBlocked']>>
): NativeChatComposerHandle => ({
  insertAgentReferences: () => false,
  focus: () => true,
  insertTypedText: () => false,
  acceptsText: () => true,
  appendText: () => {},
  handlePasteEvent: () => {},
  pasteFromClipboard: () => {},
  contains: () => false,
  notesBlocked: () => blocked
})

/** A chat with an empty message box, so Send is offered as it is in a real chat; `blocked` is what
 *  the box is doing instead of taking notes. */
function InChat({
  blocked = null
}: {
  blocked?: ReturnType<NonNullable<NativeChatComposerHandle['notesBlocked']>>
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(
    () =>
      box.current
        ? registerNativeChatComposerDestination(
            box.current,
            { current: composerFor(blocked) },
            true,
            'fixture'
          )
        : undefined,
    [blocked]
  )
  return (
    <div data-native-chat-root="true">
      <div ref={box} data-native-chat-composer-scope="fixture" />
      <NativeChatMediaViewer
        open
        onOpenChange={() => {}}
        src={SAMPLE}
        title="dashboard.png"
        source={{ path: '/tmp/dashboard.png' }}
        opener={box}
        initialNotes={NOTES}
      />
    </div>
  )
}

export const annotating = defineFixture({
  width: 1280,
  render: () => <InChat />
})

/** The message box is setting a goal: Send says why the notes wait. */
export const goalHeld = defineFixture({
  width: 1280,
  render: () => <InChat blocked="goal" />
})

/** Over 33 megapixels: viewable, with Annotate off and its reason on hover. */
export const tooLargeToAnnotate = defineFixture({
  width: 1280,
  render: () => (
    <NativeChatMediaViewer
      open
      onOpenChange={() => {}}
      src={sample(7700, 4400)}
      title="poster-scan.png"
      source={{ path: '/tmp/poster-scan.png' }}
      opener={opener}
    />
  )
})

/** A queued message is being edited in the message box. */
export const editingHeld = defineFixture({
  width: 1280,
  render: () => <InChat blocked="editing" />
})

/** The message box holds a command. */
export const commandHeld = defineFixture({
  width: 1280,
  render: () => <InChat blocked="command" />
})

/** A narrow window: the notes panel is a bottom sheet and Send's reason sits in it. */
export const goalHeldNarrow = defineFixture({
  width: 360,
  render: () => <InChat blocked="goal" />
})
