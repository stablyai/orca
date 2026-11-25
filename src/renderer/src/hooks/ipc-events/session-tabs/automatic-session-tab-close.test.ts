import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import {
  answerAutomaticSessionTabClose,
  automaticSessionTabCloseKept
} from './automatic-session-tab-close'
import {
  AUTOMATIC_CLOSE_CONSENT_TTL_MS,
  automaticCloseKeepsAtAdoption,
  forgetAutomaticCloseConsent,
  resetAutomaticCloseConsents
} from '../../../runtime/web-session-tabs-sync/closing/automatic-close-consents'

const SINCE = 1_000_000
const WT = 'bot-home'

function tab(id: string, overrides: Partial<Tab> = {}): Tab {
  return {
    id,
    entityId: `entity-${id}`,
    groupId: 'g1',
    worktreeId: WT,
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: SINCE - 10,
    ...overrides
  }
}

function state(tabs: Tab[], activeTabId: string | null) {
  const group: TabGroup = {
    id: 'g1',
    worktreeId: WT,
    activeTabId,
    tabOrder: tabs.map((entry) => entry.id)
  }
  return { unifiedTabsByWorktree: { [WT]: tabs }, groupsByWorktree: { [WT]: [group] } }
}

const kept = (tabs: Tab[], activeTabId: string | null, id: string) =>
  automaticSessionTabCloseKept(state(tabs, activeTabId), WT, id, { keptIfTouchedSince: SINCE })

afterEach(() => resetAutomaticCloseConsents())

describe('automaticSessionTabCloseKept', () => {
  it('lets an untouched tab behind another go', () => {
    expect(kept([tab('front'), tab('old')], 'front', 'old')).toBe(false)
  })

  it('keeps the tab in front, a pinned one, and one focused or opened since', () => {
    expect(kept([tab('a')], 'a', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { isPinned: true })], 'front', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { lastFocusedAt: SINCE })], 'front', 'a')).toBe(true)
    expect(kept([tab('front'), tab('a', { createdAt: SINCE + 1 })], 'front', 'a')).toBe(true)
  })

  it('finds the tab by its entity too, and keeps one it cannot find (its mapping may lag)', () => {
    expect(kept([tab('front'), tab('a', { isPinned: true })], 'front', 'entity-a')).toBe(true)
    expect(kept([tab('front')], 'front', 'missing')).toBe(true)
  })
})

describe('the removal after consent', () => {
  const consent = (tabs: Tab[], id: string, at = SINCE) =>
    answerAutomaticSessionTabClose(state(tabs, 'front'), WT, id, { keptIfTouchedSince: at }, at)

  it('drops the tab at adoption when nobody used it after consenting', () => {
    const old = tab('old')
    expect(consent([tab('front'), old], 'old')).toBe('consent')
    const reveal = vi.fn()
    expect(
      automaticCloseKeepsAtAdoption(state([tab('front'), old], 'front'), WT, old, reveal, SINCE + 1)
    ).toBe(false)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('keeps it and asks the host once to show it again when focus, front or a reopen came after consent', () => {
    const old = tab('old')
    consent([tab('front'), old], 'old')
    const reveal = vi.fn()
    const focused = { ...old, lastFocusedAt: SINCE + 5 }
    const adopt = () =>
      automaticCloseKeepsAtAdoption(
        state([tab('front'), focused], 'front'),
        WT,
        focused,
        reveal,
        SINCE + 10
      )
    expect(adopt()).toBe(true)
    expect(adopt()).toBe(true)
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal).toHaveBeenCalledWith('entity-old')
    consent([tab('front'), old], 'old')
    expect(automaticCloseKeepsAtAdoption(state([old], 'old'), WT, old, vi.fn(), SINCE + 10)).toBe(
      true
    )
  })

  it('decides nothing without a consent, after the host lists the chat again, or once it expired', () => {
    const old = tab('old', { lastFocusedAt: SINCE + 5 })
    expect(automaticCloseKeepsAtAdoption(state([old], 'old'), WT, old, vi.fn(), SINCE + 1)).toBe(
      false
    )
    consent([tab('front'), tab('old')], 'old')
    forgetAutomaticCloseConsent(WT, 'entity-old')
    expect(automaticCloseKeepsAtAdoption(state([old], 'old'), WT, old, vi.fn(), SINCE + 1)).toBe(
      false
    )
    consent([tab('front'), tab('old')], 'old')
    expect(
      automaticCloseKeepsAtAdoption(
        state([old], 'old'),
        WT,
        old,
        vi.fn(),
        SINCE + AUTOMATIC_CLOSE_CONSENT_TTL_MS + 1
      )
    ).toBe(false)
  })
})
