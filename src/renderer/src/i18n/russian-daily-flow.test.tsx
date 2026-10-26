// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatApprovalCard } from '@/components/native-chat/NativeChatApprovalCard'
import { NativeChatEmptyState } from '@/components/native-chat/NativeChatEmptyState'
import { NativeChatQueuedMessageCard } from '@/components/native-chat/NativeChatQueuedMessageCard'
import { NativeChatSessionOptionPickers } from '@/components/native-chat/NativeChatSessionOptionPickers'
import type { SessionOptionDescriptor } from '../../../shared/native-chat-session-options'
import { getIntlLocale, setRendererUiLanguage } from './i18n'
import { getUiWeekdayNames } from './weekday-names'
import { formatUiRelativeTime } from './relative-time-format'

beforeEach(async () => {
  await setRendererUiLanguage('ru')
})

afterEach(async () => {
  cleanup()
  await setRendererUiLanguage('en')
})

describe('Russian daily conversation', () => {
  it('updates the memoized busy model picker when the interface language changes', async () => {
    const snapshot: SessionOptionDescriptor[] = [
      {
        id: 'model',
        label: 'Model',
        category: 'model',
        kind: {
          type: 'select',
          currentValue: 'fixture-model',
          choices: [{ value: 'fixture-model', label: 'Fixture model' }]
        },
        valueSource: 'reported',
        transport: 'agent-session',
        settable: true
      }
    ]
    const surface = {
      getSnapshot: () => snapshot,
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => undefined
    }
    render(
      <TooltipProvider>
        <NativeChatSessionOptionPickers surface={surface} snapshot={snapshot} isWorking />
      </TooltipProvider>
    )
    const russian = screen.getByRole('button', { name: /Fixture model/ }).getAttribute('aria-label')
    expect(russian).toBe('Модель Fixture model')
    expect(screen.getByRole('button', { name: russian ?? '' }).hasAttribute('disabled')).toBe(true)
    await act(() => setRendererUiLanguage('en'))
    expect(screen.getByRole('button', { name: 'Model Fixture model' })).toBeTruthy()
    await act(() => setRendererUiLanguage('ru'))
    expect(screen.getByRole('button', { name: /Fixture model/ }).getAttribute('aria-label')).toBe(
      russian
    )
  })

  it('renders the real empty chat and actionable queued message in Russian', () => {
    const steer = vi.fn()
    render(
      <TooltipProvider>
        <NativeChatEmptyState kind="empty" agent="codex" />
        <ul>
          <NativeChatQueuedMessageCard
            card={{
              messageId: 'queued-ru',
              position: 1,
              text: 'Проверь изменения',
              state: 'waiting',
              hold: 'turn'
            }}
            chatWorktreeId={null}
            showsSteerShortcut={false}
            onSteer={steer}
            onDelete={() => {}}
          />
        </ul>
      </TooltipProvider>
    )
    expect(screen.getByText('Начните чат с Codex')).toBeTruthy()
    expect(screen.getByText('Проверь изменения')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Сейчас' }))
    expect(steer).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Удалить' })).toBeTruthy()
  })

  it('localizes application permission controls while retaining original provider content', () => {
    const cancel = vi.fn()
    render(
      <NativeChatApprovalCard
        approval={{
          title: 'Allow command?',
          detail: 'pnpm test',
          decisionReason: 'Outside the workspace',
          options: [{ label: 'Allow once', send: 'allow_once' }]
        }}
        onChoose={() => {}}
        onCancel={cancel}
      />
    )
    expect(screen.getByRole('group', { name: 'Allow command?' })).toBeTruthy()
    expect(screen.getByText('Причина:')).toBeTruthy()
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('formats numbers, dates, relative time and weekdays with the selected Russian locale', () => {
    expect(getIntlLocale()).toBe('ru')
    expect(new Intl.NumberFormat(getIntlLocale()).format(1234.5)).toBe('1 234,5')
    expect(
      new Intl.DateTimeFormat(getIntlLocale(), { month: 'long', timeZone: 'UTC' }).format(
        new Date('2026-10-24T12:00:00Z')
      )
    ).toBe('октябрь')
    expect(formatUiRelativeTime(-5 * 60_000)).toBe('5 минут назад')
    expect(getUiWeekdayNames()[1]).toBe('понедельник')
  })
})
