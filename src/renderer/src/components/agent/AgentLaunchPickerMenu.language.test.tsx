// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import es from '@/i18n/locales/es.json'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

it('refreshes translated row labels on a language change with unchanged props', async () => {
  const language = i18n.language
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const entry: AgentPickerEntry = {
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'chat-unavailable', reason: 'ssh' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models: [] }
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    i18n.addResourceBundle('es', 'translation', es)
    await i18n.changeLanguage('en')
    act(() =>
      root.render(
        <TooltipProvider>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu entries={[entry]} runLaunch={vi.fn()} />
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipProvider>
      )
    )
    const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
    expect(row.textContent).toContain('No chat over SSH')
    await act(async () => {
      await i18n.changeLanguage('es')
    })
    expect(row.textContent).toContain(es.auto.components.tab.bar.QuickLaunchButton.chatNotOverSsh)
    expect(row.textContent).not.toContain('No chat over SSH')
  } finally {
    act(() => root.unmount())
    host.remove()
    await i18n.changeLanguage(language)
    vi.unstubAllGlobals()
  }
})
