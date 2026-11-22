import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../native-chat-types'
import { assignNativeChatPendingOccurrence } from './native-chat-pending-occurrence'
import {
  pendingSendsAsMessages,
  prunePendingSends,
  type NativeChatPendingSend
} from './native-chat-pending-sends'

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: number
): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp,
    source: 'transcript'
  }
}

describe('pending send occurrence reconciliation', () => {
  it.each([
    { pathless: true, unrelatedImage: false, receiptKnown: false },
    { pathless: false, unrelatedImage: true, receiptKnown: true, reversed: true },
    { pathless: false, unrelatedImage: false, receiptKnown: true },
    { pathless: false, unrelatedImage: true, receiptKnown: false }
  ])(
    'does not let generated metadata retire a distinguishable copied-note send: %o',
    ({ pathless, unrelatedImage, receiptKnown, reversed }) => {
      const text = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
      const first: NativeChatPendingSend = {
        id: 'image',
        text: '',
        imagePaths: ['/repo/a.png'],
        ...(receiptKnown ? { deliveredImagePaths: ['/temp/a.png'] } : {}),
        sentAt: 100,
        afterMessageId: 'boundary'
      }
      const copied = assignNativeChatPendingOccurrence([first], {
        id: 'copied',
        text,
        imagePaths: unrelatedImage ? ['/repo/small.png'] : [],
        sentAt: 110,
        afterMessageId: 'boundary'
      })
      const pending = reversed ? [copied, first] : [first, copied]
      const transcript: NativeChatMessage[] = [
        message('boundary', 'assistant', 'ready', 90),
        {
          ...message('image-row', 'user', text, 120),
          blocks: [
            pathless
              ? { type: 'image-ref', url: 'data:image/png;base64,first' }
              : { type: 'image-ref', path: '/temp/a.png' },
            { type: 'text', text }
          ]
        }
      ]
      expect(pendingSendsAsMessages(pending, transcript).map((row) => row.id)).toEqual([
        'pending:copied'
      ])
      transcript.push(message('first-reply', 'assistant', 'done', 130))
      const remaining = prunePendingSends(pending, transcript)
      expect(remaining.map((entry) => entry.id)).toEqual(['copied'])
      expect(pendingSendsAsMessages(remaining, transcript).map((row) => row.id)).toEqual([
        'pending:copied'
      ])
      transcript.push({
        ...message('copied-row', 'user', text, 140),
        blocks: [
          ...(unrelatedImage ? [{ type: 'image-ref' as const, path: '/repo/small.png' }] : []),
          { type: 'text', text }
        ]
      })
      expect(pendingSendsAsMessages(remaining, transcript)).toEqual([])
      transcript.push(message('second-reply', 'assistant', 'done', 150))
      expect(prunePendingSends(remaining, transcript)).toEqual([])
    }
  )

  it('keeps the next identical echo after pruning an earlier occurrence', () => {
    const first = assignNativeChatPendingOccurrence<NativeChatPendingSend>([], {
      id: 'p1',
      text: 'repeat',
      sentAt: 100,
      afterMessageId: 'paged-out-boundary'
    })
    const repeated = [
      first,
      assignNativeChatPendingOccurrence([first], {
        id: 'p2',
        text: 'repeat',
        sentAt: 200,
        afterMessageId: 'paged-out-boundary'
      })
    ]
    expect(first.matchingOccurrence).toBeUndefined()
    expect(repeated[1]).toMatchObject({ matchingOccurrence: 2, matchingAfterTimestamp: 100 })

    const firstCompletedTurn = [
      message('u1', 'user', 'repeat', 150),
      message('a1', 'assistant', 'done', 160)
    ]
    const afterFirstPrune = prunePendingSends(repeated, firstCompletedTurn)

    expect(afterFirstPrune.map((entry) => entry.id)).toEqual(['p2'])
    expect(
      pendingSendsAsMessages(afterFirstPrune, firstCompletedTurn).map((entry) => entry.id)
    ).toEqual(['pending:p2'])

    const secondCompletedTurn = [
      ...firstCompletedTurn,
      message('u2', 'user', 'repeat', 250),
      message('a2', 'assistant', 'done again', 260)
    ]
    expect(pendingSendsAsMessages(afterFirstPrune, secondCompletedTurn)).toEqual([])
    expect(prunePendingSends(afterFirstPrune, secondCompletedTurn)).toEqual([])
  })
})

describe('pending sends typed through an agent TUI', () => {
  const COMPOSER_TEXT = 'summarize the failing test and propose a fix'

  it('prunes the echo of a row carrying the clear byte', () => {
    const pending = [{ id: 'p1', text: COMPOSER_TEXT, sentAt: 100, afterMessageId: 'boundary' }]
    const transcript = [
      message('u1', 'user', `\u0015${COMPOSER_TEXT}`, 150),
      message('a1', 'assistant', 'done', 160)
    ]

    expect(prunePendingSends(pending, transcript)).toEqual([])
    expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  })

  it('lets each pathless image row retire one delivered image-only send, once, oldest first', () => {
    const send = (
      id: string,
      extra: Partial<NativeChatPendingSend> = {}
    ): NativeChatPendingSend => ({
      id,
      text: '',
      imagePaths: [`/tmp/orca-paste-${id}.png`],
      sentAt: 100,
      afterMessageId: 'working',
      ...extra
    })
    const pending = [send('a', { delivery: 'rejected' }), send('b'), send('c')]
    const imageRow = (id: string, timestamp: number): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'image-ref', url: 'data:image/png;base64,iVBORw0K' }],
      timestamp,
      source: 'transcript'
    })
    const before = [imageRow('older-image', 50), message('working', 'assistant', 'busy', 90)]
    expect(pendingSendsAsMessages(pending, before).map((row) => row.id)).toEqual([
      'pending:a',
      'pending:b',
      'pending:c'
    ])

    const landed = [...before, imageRow('queued-image', 110)]
    expect(pendingSendsAsMessages(pending, landed).map((row) => row.id)).toEqual([
      'pending:a',
      'pending:c'
    ])
    expect(prunePendingSends(pending, landed)).toBe(pending)
    const replied = [...landed, message('reply', 'assistant', 'ok', 120)]
    const remaining = prunePendingSends(pending, replied)
    expect(remaining.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(pendingSendsAsMessages(remaining, replied).map((row) => row.id)).toEqual([
      'pending:a',
      'pending:c'
    ])
    expect(prunePendingSends(remaining, replied).map((entry) => entry.id)).toEqual(['a', 'c'])
  })
})

it('reconciles a fitted attachment path while retaining the original for preview and retry', () => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'p1',
      text: 'look at this',
      imagePaths: ['/repo/hero.png'],
      deliveredImagePaths: ['/temp/fitted.png'],
      sentAt: 100
    }
  ]
  const transcript = [
    message(
      'u1',
      'user',
      '/temp/fitted.png look at this\n\n[Image source file: "/repo/hero.png"; attached viewing copy: "/temp/fitted.png"]',
      150
    ),
    message('a1', 'assistant', 'done', 160)
  ]
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  expect(prunePendingSends(pending, transcript)).toEqual([])
  expect(pending[0]?.imagePaths).toEqual(['/repo/hero.png'])
})

it('reconciles an image-only echo that names the delivered copy', () => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'p1',
      text: '',
      imagePaths: ['/repo/hero.png'],
      deliveredImagePaths: ['/temp/fitted.png'],
      sentAt: 100
    }
  ]
  const transcript: NativeChatMessage[] = [
    {
      ...message('u1', 'user', '', 150),
      blocks: [{ type: 'image-ref', path: '/temp/fitted.png' }]
    },
    message('a1', 'assistant', 'done', 160)
  ]
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  expect(prunePendingSends(pending, transcript)).toEqual([])
})

it('retires each delivered version of the same original filename once across pruning', () => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'p1',
      text: '',
      imagePaths: ['/repo/shot.png'],
      deliveredImagePaths: ['/temp/v1.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    },
    {
      id: 'p2',
      text: '',
      imagePaths: ['/repo/shot.png'],
      deliveredImagePaths: ['/temp/v2.png'],
      sentAt: 110,
      afterMessageId: 'boundary',
      matchingOccurrence: 2
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    {
      ...message(
        'u1',
        'user',
        '[Image source file: "/repo/shot.png"; attached viewing copy: "/temp/v1.png"]',
        120
      ),
      blocks: [
        { type: 'image-ref', path: '/temp/v1.png' },
        {
          type: 'text',
          text: '[Image source file: "/repo/shot.png"; attached viewing copy: "/temp/v1.png"]'
        }
      ]
    },
    message('a1', 'assistant', 'first', 130)
  ]
  const remaining = prunePendingSends(pending, transcript)
  expect(remaining.map((entry) => entry.id)).toEqual(['p2'])
  transcript.push({
    ...message('u2', 'user', '', 140),
    blocks: [
      { type: 'image-ref', path: '/temp/v2.png' },
      {
        type: 'text',
        text: '[Image source file: "/repo/shot.png"; attached viewing copy: "/temp/v2.png"]'
      }
    ]
  })
  expect(pendingSendsAsMessages(remaining, transcript)).toEqual([])
  transcript.push(message('a2', 'assistant', 'second', 150))
  expect(prunePendingSends(remaining, transcript)).toEqual([])
})

it('reconciles repeated captions across different source files and viewing copies', () => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'p1',
      text: 'look',
      imagePaths: ['/repo/a.png'],
      deliveredImagePaths: ['/temp/a.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    },
    {
      id: 'p2',
      text: 'look',
      imagePaths: ['/repo/b.png'],
      deliveredImagePaths: ['/temp/b.png'],
      sentAt: 110,
      afterMessageId: 'boundary',
      matchingOccurrence: 2
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    message(
      'u1',
      'user',
      'look\n\n[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]',
      120
    ),
    message(
      'u2',
      'user',
      'look\n\n[Image source file: "/repo/b.png"; attached viewing copy: "/temp/b.png"]',
      130
    ),
    message('a1', 'assistant', 'done', 140)
  ]
  transcript[1].blocks.unshift({ type: 'image-ref', path: '/temp/a.png' })
  transcript[2].blocks.unshift({ type: 'image-ref', path: '/temp/b.png' })
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  expect(prunePendingSends(pending, transcript)).toEqual([])
})

it('does not reuse an unfitted image row for a later fitted version of that file', () => {
  const pending: NativeChatPendingSend[] = [
    { id: 'p1', text: '', imagePaths: ['/repo/shot.png'], sentAt: 100, afterMessageId: 'boundary' },
    {
      id: 'p2',
      text: '',
      imagePaths: ['/repo/shot.png'],
      deliveredImagePaths: ['/temp/v2.png'],
      sentAt: 110,
      afterMessageId: 'boundary',
      matchingOccurrence: 2
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    { ...message('u1', 'user', '', 120), blocks: [{ type: 'image-ref', path: '/repo/shot.png' }] },
    message('a1', 'assistant', 'first', 130)
  ]
  const remaining = prunePendingSends(pending, transcript)
  expect(remaining.map((entry) => entry.id)).toEqual(['p2'])
  expect(pendingSendsAsMessages(remaining, transcript).map((row) => row.id)).toEqual(['pending:p2'])
})

it.each([
  '[Image source file: "/repo/rejected.png"; attached viewing copy: "/temp/view.png"]',
  'please rerun\n\n[Image source file: "/repo/rejected.png"; attached viewing copy: "/temp/view.png"]'
])('keeps attachment-shaped human text literal without retiring a rejected image', (text) => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'failed',
      text: '',
      imagePaths: ['/repo/rejected.png'],
      delivery: 'rejected',
      sentAt: 100,
      afterMessageId: 'boundary'
    },
    { id: 'human', text, sentAt: 110, afterMessageId: 'boundary' }
  ]
  const transcript = [
    message('boundary', 'assistant', 'ready', 90),
    message('literal', 'user', text, 120),
    message('reply', 'assistant', 'done', 130)
  ]
  expect(prunePendingSends(pending, transcript).map((entry) => entry.id)).toEqual(['failed'])
  expect(pendingSendsAsMessages(pending, transcript).map((entry) => entry.id)).toEqual([
    'pending:failed'
  ])
})

it('reconciles an original filename that contains the source-context prefix', () => {
  const pending: NativeChatPendingSend[] = [
    {
      id: 'image',
      text: '',
      imagePaths: ['/repo/[Image source file: shot.png'],
      deliveredImagePaths: ['/temp/view.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    {
      ...message('image', 'user', '', 120),
      blocks: [
        { type: 'image-ref', path: '/temp/view.png' },
        {
          type: 'text',
          text: '[Image source file: "/repo/[Image source file: shot.png"; attached viewing copy: "/temp/view.png"]'
        }
      ]
    },
    message('reply', 'assistant', 'done', 130)
  ]
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
  expect(prunePendingSends(pending, transcript)).toEqual([])
})

it.each(['', 'look'])(
  'reconciles glued multi-image paths with mixed fitted sources and caption %s',
  (text) => {
    const pending: NativeChatPendingSend[] = [
      {
        id: 'mixed',
        text,
        imagePaths: ['/repo/a.png', '/repo/b.png'],
        deliveredImagePaths: ['/temp/a.png', '/repo/b.png'],
        sentAt: 100,
        afterMessageId: 'boundary'
      }
    ]
    const row = `/temp/a.png/repo/b.png ${text ? `${text}\n\n` : ''}[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"\nImage source file: "/repo/b.png"; attached viewing copy: "/repo/b.png"]`
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      message('images', 'user', row, 120),
      message('reply', 'assistant', 'done', 130)
    ]
    expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
    expect(prunePendingSends(pending, transcript)).toEqual([])
  }
)

it('keeps a copied source note literal beside an unrelated pathless image', () => {
  const text = '[Image source file: "/repo/rejected.png"; attached viewing copy: "/temp/view.png"]'
  const pending: NativeChatPendingSend[] = [
    {
      id: 'failed',
      text: '',
      imagePaths: ['/repo/rejected.png'],
      deliveredImagePaths: ['/temp/view.png'],
      delivery: 'rejected',
      sentAt: 100,
      afterMessageId: 'boundary'
    },
    {
      id: 'human',
      text,
      imagePaths: ['/repo/small.png'],
      deliveredImagePaths: ['/repo/small.png'],
      sentAt: 110,
      afterMessageId: 'boundary'
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    {
      ...message('literal', 'user', text, 120),
      blocks: [
        { type: 'image-ref', url: 'data:image/png;base64,abc' },
        { type: 'text', text }
      ]
    },
    message('reply', 'assistant', 'done', 130)
  ]
  expect(prunePendingSends(pending, transcript).map((entry) => entry.id)).toEqual(['failed'])
  expect(pendingSendsAsMessages(pending, transcript).map((row) => row.id)).toEqual([
    'pending:failed'
  ])
})

describe('copied source-note attachment evidence', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const imageSend: NativeChatPendingSend = {
    id: 'image',
    text: '',
    imagePaths: ['/repo/a.png'],
    sentAt: 100,
    afterMessageId: 'boundary',
    afterMessageTimestamp: 90
  }
  const row = (id: string, text: string, paths: string[], at: number): NativeChatMessage => ({
    ...message(id, 'user', text, at),
    blocks: [...paths.map((path) => ({ type: 'image-ref' as const, path })), { type: 'text', text }]
  })

  it('keeps the full human legacy prefix and refuses contradictory real image paths', () => {
    const human = {
      id: 'human',
      text: `/temp/a.png ${note}`,
      imagePaths: ['/repo/small.png'],
      sentAt: 110,
      afterMessageId: 'boundary'
    }
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('human-row', human.text, ['/repo/small.png'], 120),
      message('reply', 'assistant', 'done', 130)
    ]
    expect(prunePendingSends([imageSend, human], transcript).map((entry) => entry.id)).toEqual([
      'image'
    ])
    expect(
      prunePendingSends(
        [{ ...human, imagePaths: [] }],
        [
          message('boundary', 'assistant', 'ready', 90),
          row('literal', human.text, [], 120),
          message('reply', 'assistant', 'done', 130)
        ]
      )
    ).toEqual([])
  })

  it('does not carry an image offset into a text-only stream after paging', () => {
    const human = {
      id: 'human',
      text: note,
      sentAt: 110,
      afterMessageId: 'boundary',
      afterMessageTimestamp: 90
    }
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('image-row', note, ['/temp/a.png'], 120),
      message('reply', 'assistant', 'done', 130)
    ]
    const remaining = prunePendingSends([imageSend, human], transcript)
    expect(remaining.map((entry) => entry.id)).toEqual(['human'])
    expect(
      prunePendingSends(remaining, [
        row('human-row', note, [], 140),
        message('reply2', 'assistant', 'done', 150)
      ])
    ).toEqual([])
  })

  it('counts known different attachment identities in their own occurrence streams', () => {
    const first = {
      id: 'first',
      text: note,
      imagePaths: ['/temp/a.png'],
      sentAt: 100,
      afterMessageId: 'boundary'
    }
    const second = assignNativeChatPendingOccurrence([first], {
      id: 'second',
      text: note,
      imagePaths: ['/repo/small.png'],
      sentAt: 110,
      afterMessageId: 'boundary'
    })
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('first-row', note, ['/temp/a.png'], 120),
      message('reply', 'assistant', 'done', 130)
    ]
    const remaining = prunePendingSends([first, second], transcript)
    expect(remaining.map((entry) => entry.id)).toEqual(['second'])
    transcript.push(
      row('second-row', note, ['/repo/small.png'], 140),
      message('reply2', 'assistant', 'done', 150)
    )
    expect(prunePendingSends(remaining, transcript)).toEqual([])
  })

  it('does not reuse a matched row and its generated suffix as two glued sends', () => {
    const image = { ...imageSend, text: note }
    const first = { id: 'first', text: note, sentAt: 110, afterMessageId: 'boundary' }
    const second = assignNativeChatPendingOccurrence([first], {
      id: 'second',
      text: note,
      sentAt: 115,
      afterMessageId: 'boundary'
    })
    const transcript = [
      message('boundary', 'assistant', 'ready', 90),
      row('image-row', `${note}\n\n${note}`, ['/temp/a.png'], 120),
      message('reply', 'assistant', 'done', 130)
    ]
    expect(prunePendingSends([image, first, second], transcript).map((entry) => entry.id)).toEqual([
      'first',
      'second'
    ])
    expect(
      pendingSendsAsMessages([image, first, second], transcript).map((entry) => entry.id)
    ).toEqual(['pending:first', 'pending:second'])
  })
})

it('reconciles literal source-note text split across glued text-only sends', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const pending = [
    { id: 'path', text: '/temp/a.png', sentAt: 100, afterMessageId: 'boundary' },
    { id: 'note', text: note, sentAt: 110, afterMessageId: 'boundary' }
  ]
  const transcript = [
    message('boundary', 'assistant', 'ready', 90),
    message('glued', 'user', `/temp/a.png ${note}`, 120),
    message('reply', 'assistant', 'done', 130)
  ]
  expect(prunePendingSends(pending, transcript)).toEqual([])
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
})

it('reconciles glued text and fitted-image captions without counting generated context as human words', () => {
  const note = '[Image source file: "/repo/a.png"; attached viewing copy: "/temp/a.png"]'
  const pending = [
    { id: 'text', text: 'first', sentAt: 100, afterMessageId: 'boundary' },
    {
      id: 'image',
      text: 'second',
      imagePaths: ['/repo/a.png'],
      deliveredImagePaths: ['/temp/a.png'],
      sentAt: 110,
      afterMessageId: 'boundary'
    }
  ]
  const transcript: NativeChatMessage[] = [
    message('boundary', 'assistant', 'ready', 90),
    {
      ...message('glued', 'user', '', 120),
      blocks: [
        { type: 'image-ref', path: '/temp/a.png' },
        { type: 'text', text: `first [Image #1] second\n\n${note}` }
      ]
    },
    message('reply', 'assistant', 'done', 130)
  ]
  expect(prunePendingSends(pending, transcript)).toEqual([])
  expect(pendingSendsAsMessages(pending, transcript)).toEqual([])
})
