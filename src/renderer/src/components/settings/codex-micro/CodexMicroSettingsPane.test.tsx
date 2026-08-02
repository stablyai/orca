// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { CodexMicroConnectionState } from '../../../../../shared/codex-micro-types'
import { CodexMicroControlMap, codexMicroControlLabel } from './CodexMicroControlMap'
import { CodexMicroSettingsPane, updateMapping } from './CodexMicroSettingsPane'

const retry = vi.fn()
const release = vi.fn()
let stateListener: ((state: CodexMicroConnectionState) => void) | undefined

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  retry.mockReset()
  release.mockReset()
  stateListener = undefined
})

afterEach(() => {
  document.body.replaceChildren()
})

function installCodexMicroApi(initialState: CodexMicroConnectionState): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      codexMicro: {
        getState: vi.fn().mockResolvedValue(initialState),
        subscribeState: vi.fn((listener: (state: CodexMicroConnectionState) => void) => {
          stateListener = listener
          return vi.fn()
        }),
        retry,
        release
      }
    }
  })
}

async function renderPane(
  args: {
    initialState?: CodexMicroConnectionState
    updateSettings?: (updates: Partial<GlobalSettings>) => void
  } = {}
): Promise<{ root: Root; container: HTMLDivElement }> {
  installCodexMicroApi(args.initialState ?? { kind: 'disabled' })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <CodexMicroSettingsPane
        settings={getDefaultSettings('/tmp')}
        updateSettings={args.updateSettings ?? vi.fn()}
      />
    )
  })
  return { root, container }
}

function connectionActions(container: HTMLElement): string[] {
  return [...container.querySelectorAll('button')]
    .map((button) => button.textContent?.trim())
    .filter((text): text is string => text === 'Retry' || text === 'Release')
}

async function setConnection(state: CodexMicroConnectionState): Promise<void> {
  if (!stateListener) {
    throw new Error('Codex Micro state listener was not registered')
  }
  await act(async () => stateListener?.(state))
}

describe('CodexMicroSettingsPane layout', () => {
  it('shows a visible ownership row without duplicating the section badge', () => {
    const markup = renderToStaticMarkup(
      <CodexMicroSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={() => {}} />
    )

    expect(markup).toContain('>Use with Orca<')
    expect(markup).toContain('Allow Orca to connect to the Codex Micro over USB.')
    expect(markup).not.toContain('>Experimental<')
    expect(markup).toContain('data-slot="card"')
    expect(markup).not.toContain('>Retry<')
    expect(markup).toContain('Checking device')
    expect(markup).not.toContain('>Not in use<')
  })

  it('keeps the ownership switch accessible and updates the enabled setting', async () => {
    const updateSettings = vi.fn()
    const { root, container } = await renderPane({ updateSettings })
    const ownershipSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Use with Orca"]'
    )

    expect(ownershipSwitch).not.toBeNull()
    expect(container.textContent).toContain('Use with Orca')
    expect(container.textContent).toContain('Allow Orca to connect to the Codex Micro over USB.')

    await act(async () => ownershipSwitch?.click())

    expect(updateSettings).toHaveBeenCalledWith({
      codexMicro: expect.objectContaining({ enabled: true })
    })
    await act(async () => root.unmount())
  })

  it('renders descriptive physical labels and an accessible control map', () => {
    const markup = renderToStaticMarkup(
      <CodexMicroSettingsPane settings={getDefaultSettings('/tmp')} updateSettings={() => {}} />
    )

    expect(markup).toContain('aria-label="Codex Micro control map"')
    expect(markup).toContain('aria-label="Joystick directions"')
    expect(markup).toContain('data-control-id="AG00"')
    expect(markup).toContain('Top-left agent key')
    expect(markup).toContain('Dial · clockwise')
    expect(markup).toContain('>AG00<')
    expect(markup).not.toContain('data-control-id="ACT11"')
    expect(markup).not.toContain('id="codex-control-ACT11-select"')
    expect(codexMicroControlLabel('ENC_CW')).toBe('Dial · counterclockwise')
    expect(codexMicroControlLabel('ENC_CC')).toBe('Dial · clockwise')
  })

  it('keeps the joystick clear of AG01 and styles active controls accessibly', () => {
    const container = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <CodexMicroControlMap activeControl="AG01" onActivate={() => {}} onHover={() => {}} />
      ),
      'text/html'
    )
    const agentControl = container.querySelector('[data-control-id="AG01"]')
    const agentKey = agentControl?.querySelector('rect')
    const joystick = container.querySelector('[aria-label="Joystick directions"] circle')

    expect(agentControl?.hasAttribute('aria-pressed')).toBe(false)
    expect(agentControl?.getAttribute('class')).toContain('[&>text]:fill-accent-foreground')
    expect(
      Number(agentKey?.getAttribute('x')) + Number(agentKey?.getAttribute('width'))
    ).toBeLessThan(Number(joystick?.getAttribute('cx')) - Number(joystick?.getAttribute('r')))
  })

  it('renders dial rotation as annular zones around one press control', () => {
    const container = new DOMParser().parseFromString(
      renderToStaticMarkup(
        <CodexMicroControlMap activeControl={null} onActivate={() => {}} onHover={() => {}} />
      ),
      'text/html'
    )
    const counterclockwise = container.querySelector('[data-control-id="ENC_CW"]')
    const clockwise = container.querySelector('[data-control-id="ENC_CC"]')
    const press = container.querySelector('[data-control-id="ENC_CLK"]')
    const paintOrder = [...container.querySelectorAll('[data-control-id^="ENC_"]')].map((control) =>
      control.getAttribute('data-control-id')
    )

    expect(paintOrder).toEqual(['ENC_CW', 'ENC_CC', 'ENC_CLK'])
    expect(counterclockwise?.getAttribute('aria-label')).toBe('Dial · counterclockwise')
    expect(counterclockwise?.textContent).toContain('↶')
    expect(clockwise?.getAttribute('aria-label')).toBe('Dial · clockwise')
    expect(clockwise?.textContent).toContain('↷')
    expect(counterclockwise?.querySelector('path.control-surface')).not.toBeNull()
    expect(clockwise?.querySelector('path.control-surface')).not.toBeNull()
    expect(press?.querySelector('circle.control-surface')).not.toBeNull()
    expect(counterclockwise?.querySelector('circle.control-surface')).toBeNull()
    expect(clockwise?.querySelector('circle.control-surface')).toBeNull()

    const microphoneKey = container.querySelector('[data-control-id="ACT10"] rect')
    expect(microphoneKey?.getAttribute('width')).toBe('80')
    const touchSensor = container.querySelector('[aria-label="Touch sensor"]')
    expect(touchSensor?.getAttribute('role')).toBe('img')
    expect(touchSensor?.hasAttribute('data-control-id')).toBe(false)
  })

  it('links diagram controls and mapping selectors through focus', async () => {
    const { root, container } = await renderPane()
    const diagramControl = container.querySelector<SVGGElement>('[data-control-id="ACT10"]')

    expect(diagramControl).not.toBeNull()
    await act(async () => diagramControl?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const trigger = container.querySelector<HTMLButtonElement>('#codex-control-ACT10-select')
    expect(document.activeElement).toBe(trigger)

    for (const key of ['Enter', ' ']) {
      await act(async () =>
        diagramControl?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      )
      expect(document.activeElement).toBe(trigger)
    }

    const agentTrigger = container.querySelector<HTMLButtonElement>('#codex-control-AG00-select')
    await act(async () => agentTrigger?.focus())
    expect(container.querySelector('[data-control-id="AG00"]')?.getAttribute('data-active')).toBe(
      'true'
    )
    await act(async () => root.unmount())
  })

  it('shows only actions supported by each connection state', async () => {
    const { root, container } = await renderPane()
    const cases: [CodexMicroConnectionState, string[]][] = [
      [{ kind: 'disabled' }, []],
      [{ kind: 'disconnected' }, ['Retry']],
      [{ kind: 'error', code: 'open-failed', message: 'Could not open device' }, ['Retry']],
      [{ kind: 'conflict', code: 'busy', message: 'Device in use' }, ['Retry']],
      [{ kind: 'permission-error', code: 'denied', message: 'Permission required' }, ['Retry']],
      [{ kind: 'connecting' }, ['Release']],
      [{ kind: 'connected', firmware: 'v0.4.1' }, ['Release']],
      [{ kind: 'read-only', firmware: 'v0.5.0', reason: 'unknown-firmware' }, ['Retry', 'Release']]
    ]

    for (const [state, expected] of cases) {
      await setConnection(state)
      expect(connectionActions(container)).toEqual(expected)
      if ('code' in state) {
        expect(container.textContent).toContain('Diagnostics')
        expect(container.textContent).toContain(state.code)
        expect(container.textContent).toContain(state.message)
      } else {
        expect(container.textContent).not.toContain('Diagnostics')
      }
      if (state.kind === 'disabled') {
        expect(container.textContent).toContain(
          'Turn on Use with Orca, then connect the Codex Micro by USB.'
        )
      }
    }
    await act(async () => root.unmount())
  })
})

describe('CodexMicroSettingsPane mapping updates', () => {
  it('adds and explicitly removes mappings without mutating the prior snapshot', () => {
    const original = { AG00: 'worktree.navigateUp' } as const
    const added = updateMapping(original, 'ACT06', 'worktree.history.back')
    const removed = updateMapping(added, 'AG00', undefined)

    expect(added).toEqual({ AG00: 'worktree.navigateUp', ACT06: 'worktree.history.back' })
    expect(removed).toEqual({ ACT06: 'worktree.history.back' })
    expect(original).toEqual({ AG00: 'worktree.navigateUp' })
  })
})
