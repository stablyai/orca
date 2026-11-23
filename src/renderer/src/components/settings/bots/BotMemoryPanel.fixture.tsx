import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotMemoryHistoryView } from '../../../../../shared/bots/bot-memory-history'
import { BotMemoryPanel } from './BotMemoryPanel'

const MEMORY = [
  '# Memory',
  '',
  '- 2026-11-06 Releases go out on Tuesdays',
  '- 2026-11-05 Release notes never mention the build origin',
  '- 2026-11-04 Staging deploys go out on Thursdays · from: Slack, Dana',
  '- 2026-11-01 Times in Eastern',
  ''
].join('\n')

const at = (daysAgo: number, hour: number, minute: number): number => {
  const day = new Date()
  day.setDate(day.getDate() - daysAgo)
  day.setHours(hour, minute, 0, 0)
  return day.getTime()
}

const line = (text: string, after: string | null = '# Memory') => ({ line: text, after })

const ROWS: BotMemoryHistoryView[] = [
  {
    id: 'r1',
    at: at(0, 9, 42),
    by: { kind: 'chat', sessionId: 's1', source: null },
    chat: 'Release prep',
    change: { added: [line('- 2026-11-06 Releases go out on Tuesdays')], removed: [] },
    undoable: true
  },
  {
    id: 'r2',
    at: at(0, 9, 12),
    by: { kind: 'owner' },
    chat: null,
    change: {
      added: [line('- 2026-11-04 Staging deploys go out on Thursdays · from: Slack, Dana')],
      removed: [line('- 2026-10-02 Staging deploys go out on Fridays')]
    },
    undoable: true
  },
  {
    id: 'r3',
    at: at(0, 8, 30),
    by: { kind: 'kept', sessionId: 's2' },
    chat: 'Slack #eng',
    change: { added: [line('- 2026-11-01 Times in Eastern')], removed: [] },
    undoable: true
  },
  {
    id: 'r4',
    at: at(1, 16, 41),
    by: { kind: 'chat', sessionId: 's1', source: null },
    chat: 'Release prep',
    change: {
      added: [line('- 2026-11-05 Release notes never mention the build origin')],
      removed: []
    },
    undoable: true
  },
  {
    id: 'r5',
    at: at(1, 14, 5),
    by: { kind: 'bot', sessionId: 's1' },
    chat: 'Release prep',
    change: { added: [], removed: [line('- 2026-10-20 Cut releases on Fridays')] },
    undoable: true
  },
  {
    id: 'r6',
    at: at(1, 11, 2),
    by: { kind: 'owner' },
    chat: null,
    change: { added: [line('- 2026-11-05 Deploy key [redacted-secret]')], removed: [] },
    undoable: false
  }
]

function stubHistory(): void {
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) =>
      method === 'bots.memory.history'
        ? { ok: true, result: { rows: ROWS } }
        : { ok: false, error: { code: 'runtime_error', message: method } }
  })
}

const file = { disk: MEMORY, refresh: async () => {} }

export const facts = defineFixture({
  width: 640,
  render: () => <BotMemoryPanel bot={{ hostId: 'local', id: 'release-manager' }} file={file} />
})

/** History open, one change opened and focused, so its Undo shows as on hover. */
export const history = defineFixture({
  width: 640,
  setup: stubHistory,
  render: () => <BotMemoryPanel bot={{ hostId: 'local', id: 'release-manager' }} file={file} />,
  interact: async (frame) => {
    const tab = [...frame.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (element) => element.textContent === 'History'
    )
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    for (let wait = 0; wait < 50 && !frame.querySelector('[aria-expanded]'); wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const row = frame.querySelectorAll<HTMLElement>('[aria-expanded]')[1]
    row?.click()
    row?.focus()
  }
})

const UNDASHED = {
  disk: [
    '# Memory',
    '',
    '2026-11-06 Releases go out on Tuesdays',
    'Release notes never mention the build origin',
    '- 2026-11-01 Times in Eastern',
    ''
  ].join('\n'),
  refresh: async () => {}
}

/** Lines written without a dash are facts like any other. */
export const undashed = defineFixture({
  width: 640,
  render: () => <BotMemoryPanel bot={{ hostId: 'local', id: 'release-manager' }} file={UNDASHED} />
})
