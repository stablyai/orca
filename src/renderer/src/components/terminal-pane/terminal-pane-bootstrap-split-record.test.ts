import { beforeEach, expect, it, vi } from 'vitest'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { recordLayoutApply } from '@/runtime/layout-apply-send'
import { isTerminalLeafId, type TerminalLeafId } from '../../../../shared/stable-pane-id'
import { recordingBootstrapSplits } from './terminal-pane-bootstrap-split-record'

const mocks = vi.hoisted(() => ({ recordLayoutApply: vi.fn<typeof recordLayoutApply>() }))
vi.mock('@/runtime/layout-apply-send', () => ({ recordLayoutApply: mocks.recordLayoutApply }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

function leafId(value: string): TerminalLeafId {
  if (!isTerminalLeafId(value)) {
    throw new Error(`not a pane id: ${value}`)
  }
  return value
}

const SOURCE = leafId('11111111-1111-4111-8111-111111111111')
const CREATED = leafId('22222222-2222-4222-8222-222222222222')

function fakeManager(created: Pick<ManagedPane, 'id' | 'leafId'> | null) {
  const splitPane = vi.fn(() => created)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder reads only these members.
  const manager = {
    getLeafId: (paneId: number) => (paneId === 1 ? SOURCE : null),
    splitPane
  } as unknown as PaneManager
  return { manager, splitPane }
}

beforeEach(() => mocks.recordLayoutApply.mockReset())

it('draws a startup split at once, then records it in main under the window’s pane id', () => {
  const { manager, splitPane } = fakeManager({ id: 2, leafId: CREATED })

  const pane = recordingBootstrapSplits(manager, 'wt-1', 'tab-1').splitPane(1, 'horizontal')

  expect(pane).toEqual({ id: 2, leafId: CREATED })
  expect(splitPane).toHaveBeenCalledWith(1, 'horizontal', undefined)
  expect(mocks.recordLayoutApply).toHaveBeenCalledWith({}, 'wt-1', {
    type: 'splitPane',
    tabId: 'tab-1',
    leafId: SOURCE,
    direction: 'horizontal',
    newLeafId: CREATED
  })
})

it('records nothing for a split the manager did not make', () => {
  const { manager } = fakeManager(null)

  recordingBootstrapSplits(manager, 'wt-1', 'tab-1').splitPane(1, 'vertical')

  expect(mocks.recordLayoutApply).not.toHaveBeenCalled()
})
