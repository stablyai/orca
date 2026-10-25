// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { WorktreeCardPortsTrigger } from '@/components/sidebar/WorktreeCardPorts'
import { DashboardAgentChildDisclosure } from '@/components/dashboard/DashboardAgentChildDisclosure'
import { CommentReactions } from '@/components/github/CommentReactions'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { notifyDirectWorkItemAgentStartTimeout } from '@/lib/launch-work-item-direct-agent'
import { normalizeStoredWebOverrides } from '@/web/preload-api/web-keybinding-normalization'
import * as keybindings from '../../../shared/keybindings'
import type { KeybindingFileDiagnostic } from '../../../shared/keybindings'
import type { WorkspacePort } from '../../../shared/workspace-ports'
import { i18n } from './i18n'
import russian from './test-resources/runtime-source-grammar.json'

const mocks = vi.hoisted(() => ({
  state: {
    recordFeatureInteraction: vi.fn(),
    activeWorktreeId: 'workspace',
    tabsByWorktree: { workspace: [{ id: 'tab', ptyId: 7 }] }
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
}))
vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

const port: WorkspacePort = {
  id: 'port',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 3000,
  pid: 123,
  processName: 'node',
  protocol: 'http',
  kind: 'workspace',
  owner: {
    worktreeId: 'workspace',
    repoId: 'repo',
    displayName: 'app',
    path: '/repo/app',
    confidence: 'cwd'
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  i18n.addResourceBundle('ru', 'translation', russian, true, true)
  await i18n.changeLanguage('ru')
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await i18n.changeLanguage('en')
})

describe('runtime source grammar', () => {
  it.each([
    [0, '', '', ''],
    [1, '1 активный порт', '1 дочернего агента', '1 реакция «сердце»'],
    [2, '2 активных порта', '2 дочерних агентов', '2 реакции «сердце»'],
    [5, '5 активных портов', '5 дочерних агентов', '5 реакций «сердце»'],
    [21, '21 активный порт', '21 дочернего агента', '21 реакция «сердце»']
  ] as const)(
    'renders port, child and reaction counts for %i',
    (count, ports, children, reactions) => {
      const toggle = vi.fn()
      const { rerender, container } = render(
        <TooltipProvider>
          <WorktreeCardPortsTrigger ports={Array.from({ length: count }, () => port)} />
          <DashboardAgentChildDisclosure
            childAgentCount={count}
            childAgentsExpanded={false}
            onToggleChildAgents={toggle}
          />
          <CommentReactions reactions={[{ content: 'heart', count }]} />
        </TooltipProvider>
      )
      if (count === 0) {
        expect(container.textContent).toBe('')
        expect(screen.queryByRole('button')).toBeNull()
        return
      }
      expect(screen.getByRole('button', { name: ports })).toBeTruthy()
      expect(screen.getByLabelText(reactions)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: `Показать ${children}` }))
      expect(toggle).toHaveBeenCalledOnce()
      rerender(
        <DashboardAgentChildDisclosure
          childAgentCount={count}
          childAgentsExpanded
          onToggleChildAgents={toggle}
        />
      )
      expect(
        screen.getByRole('button', { name: `Скрыть ${children}` }).getAttribute('aria-expanded')
      ).toBe('true')
    }
  )

  it('localizes every reaction name while keeping the GitHub reaction value intact', () => {
    const change = vi.fn(() => true)
    render(
      <TooltipProvider>
        <CommentReactions onReactionChange={change} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Добавить реакцию' }))
    for (const name of [
      'палец вверх',
      'палец вниз',
      'смех',
      'замешательство',
      'сердце',
      'ура',
      'ракета',
      'глаза'
    ]) {
      expect(screen.getByRole('button', { name: `Добавить реакцию «${name}»` })).toBeTruthy()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Добавить реакцию «смех»' }))
    expect(change).toHaveBeenCalledWith('laugh', true)
  })

  it.each([true, false])('uses a whole paste-timeout message for submitted=%s', (submitted) => {
    createPasteReadinessTimeoutNotice({
      worktreeId: 'workspace',
      tabId: 'tab',
      agent: 'codex',
      submitted
    }).onTimeout()
    expect(toast.message).toHaveBeenLastCalledWith(
      submitted
        ? 'Запрос не отправлен — вставьте его, когда агент будет готов.'
        : 'Заметки не отправлены — вставьте их, когда агент будет готов.'
    )
    notifyDirectWorkItemAgentStartTimeout('codex', submitted)
    expect(toast.message).toHaveBeenLastCalledWith(
      submitted
        ? 'Агент запускается слишком долго. Рабочее пространство готово — вставьте запрос, когда агент освободится.'
        : 'Агент запускается слишком долго. Рабочее пространство готово — вставьте контекст задачи, когда агент освободится.'
    )
  })

  it('localizes only the shortcut parser fallback and retains diagnostics and action IDs', () => {
    const normalize = vi.spyOn(keybindings, 'normalizeKeybindingArrayForAction')
    const diagnostics: KeybindingFileDiagnostic[] = []
    normalize.mockReturnValueOnce({ ok: true, value: 'Ctrl+J' })
    normalizeStoredWebOverrides({ 'worktree.palette': ['Ctrl+J'] }, 'platforms.win32', diagnostics)
    expect(diagnostics[0]).toMatchObject({
      section: 'platforms.win32',
      actionId: 'worktree.palette',
      message:
        'Сочетание клавиш для «worktree.palette» пропущено: Не удалось разобрать сочетание клавиш.'
    })
    normalize.mockReturnValueOnce({ ok: false, error: 'Parser diagnostic: Ctrl++Alt' })
    normalizeStoredWebOverrides({ 'worktree.palette': ['Ctrl+J'] }, 'platforms.linux', diagnostics)
    expect(diagnostics[1]?.message).toContain('Parser diagnostic: Ctrl++Alt')
    expect(diagnostics[1]?.actionId).toBe('worktree.palette')
  })

  it('keeps English singular and plural source defaults', async () => {
    await i18n.changeLanguage('en')
    const { rerender } = render(<WorktreeCardPortsTrigger ports={[port]} />)
    expect(screen.getByRole('button', { name: '1 live port' })).toBeTruthy()
    rerender(<WorktreeCardPortsTrigger ports={[port, port]} />)
    expect(screen.getByRole('button', { name: '2 live ports' })).toBeTruthy()
  })
})
