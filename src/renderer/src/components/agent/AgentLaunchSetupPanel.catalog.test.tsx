// @vitest-environment happy-dom
import {
  AgentLaunchSetupPanel,
  entry,
  host,
  root,
  onUse
} from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent } from '@testing-library/react'
import { expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

it.each([
  ['pending', { origin: 'unknown' }, null, true],
  ['failed', { origin: 'unknown' }, 'Could not load Pi models.', false],
  ['unsupported', { origin: 'unknown' }, 'Pi models are unavailable on this host.', false],
  ['settled', { origin: 'unknown' }, 'Pi models have not loaded.', false],
  ['settled', { origin: 'unknown', listingInProgress: true }, 'Pi models have not loaded.', false],
  [
    'settled',
    { origin: 'unknown', unavailable: { reason: 'notSignedIn' } },
    'Sign in to Pi',
    false
  ],
  ['settled', { origin: 'unknown', unavailable: { reason: 'cliMissing' } }, 'Install Pi', false],
  ['settled', { origin: 'probe', fetchedAt: 1, models: [] }, 'Pi has no available models.', false]
] satisfies [
  NonNullable<AgentPickerEntry['catalogRead']>,
  AgentPickerEntry['catalog'],
  string | null,
  boolean
][])(
  'distinguishes catalog %s/%j without gating the literal action',
  (catalogRead, catalog, message, busy) => {
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={{
              ...entry,
              agent: 'pi',
              label: 'Pi',
              catalogRead,
              catalog,
              terminal: { permissionMode: 'ask' },
              arguments: '--debug',
              defaultSurface: 'terminal'
            }}
            initial={{
              agent: 'pi',
              surface: 'terminal',
              arguments: '--debug',
              choices: { permissionMode: 'ask' }
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
    expect(input.getAttribute('aria-busy')).toBe(String(busy))
    expect(input.disabled).toBe(busy)
    expect(host.textContent).not.toContain('No models match your search.')
    if (message) {
      expect(host.querySelector('[role="status"]')?.textContent).toContain(message)
    } else {
      expect(host.querySelector('[role="status"]')).toBeNull()
    }
    const launch = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Launch terminal')
    )!
    expect(launch.disabled).toBe(false)
    fireEvent.click(launch)
    expect(onUse).toHaveBeenCalledOnce()
    expect(onUse.mock.calls[0][0]).toMatchObject({
      arguments: '--debug',
      choices: { permissionMode: 'ask' }
    })
  }
)

it('keeps known seed choices usable after catalog failure and preserves an opaque draft across publication', async () => {
  const failed: AgentPickerEntry = { ...entry, arguments: '', catalogRead: 'failed' }
  const draw = (value: AgentPickerEntry) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={value}
            initial={{
              agent: 'claude',
              surface: 'terminal',
              choices: { model: 'retired-model', permissionMode: 'ask' },
              arguments: '--debug'
            }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
  draw(failed)
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!.disabled).toBe(
    false
  )
  expect(host.textContent).toContain('retired-model')
  draw({
    ...failed,
    catalogRead: 'settled',
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'new-model', label: 'New model', isDefault: true, efforts: [] }]
    }
  })
  fireEvent.click(
    [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Launch terminal')
    )!
  )
  expect(onUse.mock.calls[0][0]).toMatchObject({
    choices: { model: 'retired-model' },
    arguments: '--debug'
  })
})

it('renders localized unresolved guidance from the real Spanish catalog', async () => {
  const { i18n, loadRendererUiLanguage } = await import('@/i18n/i18n')
  const language = i18n.language
  try {
    await loadRendererUiLanguage('es')
    await i18n.changeLanguage('es')
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupPanel
            entry={{ ...entry, agent: 'pi', label: 'Pi', catalogRead: 'settled' }}
            onUse={onUse}
          />
        </TooltipProvider>
      )
    )
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      'Los modelos de Pi no se han cargado. Cierra y vuelve a abrir el selector de agentes para intentarlo de nuevo.'
    )
    expect(host.textContent).not.toContain('No models match your search.')
  } finally {
    await i18n.changeLanguage(language)
  }
})
