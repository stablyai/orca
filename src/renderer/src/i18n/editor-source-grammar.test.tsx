// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PRTriageStrip } from '@/components/right-sidebar/checks-panel/triage-strip'
import { ConflictingFilesSection } from '@/components/right-sidebar/checks-panel/conflict-summary'
import {
  localizedPushCount as describePushCount,
  localizedPullCount as describePullCount,
  localizedFastForwardCount as describeFastForwardCount,
  localizedSyncCounts as describeSyncCounts,
  localizedForcePushWithLease as formatForcePushTitle,
  localizedManualForcePush as formatManualForcePushTitle,
  localizedUnpublishedForcePush as formatUnpublishedForcePushTitle
} from '@/components/right-sidebar/source-control-count-localized-copy'
import {
  DiffNotesPreviewPopover,
  ClearDiffNotesDialog
} from '@/components/editor/combined-diff/review-controls/combined-diff-notes-popover'
import { RichMarkdownDocLinkMenu } from '@/components/editor/RichMarkdownDocLinkMenu'
import { AiVaultScanProgressStrip } from '@/components/right-sidebar/AiVaultScanProgressStrip'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import { i18n } from './i18n'
import russian from './test-resources/runtime-source-grammar.json'

beforeEach(async () => {
  i18n.addResourceBundle('ru', 'translation', russian, true, true)
  await i18n.changeLanguage('ru')
})
afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('editor and source-control source grammar', () => {
  it.each([
    [0, 'коммитов'],
    [1, 'коммит'],
    [2, 'коммита'],
    [5, 'коммитов'],
    [21, 'коммит']
  ] as const)(
    'inflects counted sync action tooltips for %i commits and preserves upstream refs',
    (count, noun) => {
      expect(describePushCount(count)).toBe(`Отправить ${count} ${noun}`)
      expect(describePullCount(count)).toBe(`Получить ${count} ${noun}`)
      expect(describeFastForwardCount(count)).toBe(`Продвинуть ветку на ${count} ${noun}`)
      expect(describeSyncCounts(count, 2)).toBe(`Получить: 2, отправить: ${count}`)
      const upstream = 'origin/feature & <raw>'
      const title = formatForcePushTitle(count, upstream)
      expect(title).toContain(count ? `${count} ${noun} ветки` : 'эту ветку')
      expect(title).toContain(upstream)
      expect(formatManualForcePushTitle(count, 2, upstream)).toContain(
        'и заменить коммиты, которые есть только на удалённой ветке.'
      )
      expect(formatUnpublishedForcePushTitle(count)).toContain(
        'при необходимости настроить отслеживаемую ветку.'
      )
      expect(title).not.toMatch(/Force push|branch commits|the remote branch/)
    }
  )

  it.each([
    [1, '1 проверка'],
    [2, '2 проверки'],
    [5, '5 проверок'],
    [21, '21 проверка']
  ] as const)(
    'uses whole failing, pending and unresolved check summaries for %i',
    (count, phrase) => {
      for (const kind of ['failing', 'pending', 'unresolved'] as const) {
        const checks: PRCheckDetail[] = Array.from({ length: count }, () => ({
          name: 'provider-check-name',
          url: null,
          status: kind === 'pending' ? 'in_progress' : 'completed',
          conclusion: kind === 'failing' ? 'failure' : null
        }))
        const text = renderToStaticMarkup(
          <PRTriageStrip
            checks={checks}
            isResolvingConflictsWithAI={false}
            onResolveConflictsWithAI={() => {}}
            isFixingChecksWithAI={false}
            onFixChecksWithAI={() => {}}
          />
        ).replace(/<[^>]+>/g, '')
        const state =
          kind === 'failing' ? 'с ошибкой' : kind === 'pending' ? 'в ожидании' : 'без результата'
        expect(text).toContain(`${phrase} ${state}`)
        expect(text).not.toMatch(/check|pending|unresolved/)
      }
    }
  )

  it.each([
    [0, 'коммитов'],
    [1, 'коммит'],
    [2, 'коммита'],
    [5, 'коммитов'],
    [21, 'коммит']
  ] as const)(
    'localizes the conflict summary for %i while preserving the base SHA and paths',
    (count, noun) => {
      const { container } = render(
        <ConflictingFilesSection
          pr={{
            mergeable: 'CONFLICTING',
            conflictSummary: {
              commitsBehind: count,
              baseCommit: 'deadbeef',
              baseRef: 'origin/main',
              files: ['src/raw-file.ts']
            }
          }}
        />
      )
      expect(container.textContent).toContain(
        `Отставание на ${count} ${noun} (базовый коммит: deadbeef)`
      )
      expect(screen.getByText('deadbeef').className).toContain('font-mono')
      expect(screen.getByText('src/raw-file.ts')).toBeTruthy()
    }
  )

  it.each([
    [0, '0 заметок'],
    [1, '1 заметку'],
    [2, '2 заметки'],
    [5, '5 заметок'],
    [21, '21 заметку']
  ] as const)('uses a whole clear-notes confirmation for %i', (count, phrase) => {
    const clear = vi.fn()
    render(
      <ClearDiffNotesDialog
        diffCommentCount={count}
        isClearingNotes={false}
        onConfirm={clear}
        open
        setOpen={() => {}}
      />
    )
    expect(screen.getByText(`Удалить ${phrase} из этой рабочей копии?`)).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Удалить заметки' })
    if (count > 0) {
      fireEvent.click(button)
      expect(clear).toHaveBeenCalledOnce()
    } else {
      expect(button.hasAttribute('disabled')).toBe(true)
    }
  })

  it('keeps overflow notes and keyboard hints readable without literal HTML entities', () => {
    const { container } = render(
      <>
        <DiffNotesPreviewPopover
          comments={[]}
          totalCount={21}
          copied={false}
          onCopy={() => {}}
          onClear={() => {}}
        />
        <RichMarkdownDocLinkMenu
          editor={null}
          menu={{ query: '', from: 0, to: 0, left: 0, top: 0 }}
          rows={[]}
          totalMatches={0}
          selectedIndex={0}
        />
      </>
    )
    expect(screen.getByText('Ещё 21 заметка в управлении исходным кодом')).toBeTruthy()
    expect(container.textContent).toContain('↑↓ навигация  ↵ выбрать  esc закрыть')
    expect(container.textContent).not.toContain('&nbsp;')
  })

  it.each([
    [0, '0 файлов', ''],
    [1, '1 файл', '1 база данных'],
    [2, '2 файла', '2 базы данных'],
    [5, '5 файлов', '5 баз данных'],
    [21, '21 файл', '21 база данных']
  ] as const)(
    'selects CLDR file/database labels in the scan progress rows for %i',
    (count, files, databases) => {
      render(
        <AiVaultScanProgressStrip
          progress={{
            scanId: 'scan',
            stage: 'finished',
            startedAt: 0,
            settledAt: 1000,
            read: { done: 0, total: 0 },
            agents: [{ agent: 'claude', files: count, databases: count, walking: false }]
          }}
        />
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByRole('listitem').textContent).toContain(
        databases ? `${files} · ${databases}` : files
      )
    }
  )

  it('retains English source tooltips and whole-note copy', async () => {
    await i18n.changeLanguage('en')
    expect(describePushCount(1)).toBe('Push 1 commit')
    expect(describePullCount(2)).toBe('Pull 2 commits')
    expect(formatForcePushTitle(undefined)).toContain(
      'this branch with lease to update the remote branch.'
    )
    render(
      <DiffNotesPreviewPopover
        comments={[]}
        totalCount={2}
        copied={false}
        onCopy={() => {}}
        onClear={() => {}}
      />
    )
    expect(screen.getByText('2 more notes in Source Control')).toBeTruthy()
  })
})
