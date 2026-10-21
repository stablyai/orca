// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { REPOSITORY_ADD_SCRIPT_MAX_LENGTH } from '../../../../shared/repository-add-script-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { RepositoryAddScriptSetting } from './RepositoryAddScriptSetting'
import type { SettingsHostScope } from './settings-host-scope'

type TestEnvironment = {
  id: string
  name: string
  createdAt: number
  pairingRevision?: number
}

type StoreMocks = {
  webClient: boolean
  runtimeEnvironments: TestEnvironment[]
  storeSettings: GlobalSettings | undefined
  updateSettingsOrThrow: Mock<(updates: Partial<GlobalSettings>) => void | Promise<void>>
  read: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted((): StoreMocks => ({
  webClient: false,
  runtimeEnvironments: [{ id: 'ssh-host', name: 'SSH Host', createdAt: 1, pairingRevision: 17 }],
  storeSettings: undefined,
  updateSettingsOrThrow: vi.fn<(updates: Partial<GlobalSettings>) => void | Promise<void>>(),
  read: vi.fn(),
  write: vi.fn()
}))

vi.mock('@/lib/web-client-location', () => ({
  isWebClientLocation: () => mocks.webClient
}))

vi.mock('@/store', () => {
  const state = (): {
    runtimeEnvironments: TestEnvironment[]
    settings: GlobalSettings | undefined
  } => ({
    runtimeEnvironments: mocks.runtimeEnvironments,
    settings: mocks.storeSettings
  })
  const useAppStore = (selector: (current: ReturnType<typeof state>) => unknown): unknown =>
    selector(state())
  useAppStore.getState = state
  return { useAppStore }
})

vi.mock('./repository-add-script-setting-transport', () => ({
  readHostRepositoryAddScript: mocks.read,
  writeHostRepositoryAddScript: mocks.write
}))

const LOCAL_SCOPE: SettingsHostScope = { target: { kind: 'local' }, available: true }
const REMOTE_SCOPE: SettingsHostScope = {
  target: { kind: 'environment', environmentId: 'ssh-host' },
  available: true
}

function settingsWithScript(script?: string): GlobalSettings {
  return { ...getDefaultSettings('/home/user'), repositoryAddScript: script }
}

function renderSetting(
  hostScope: SettingsHostScope = LOCAL_SCOPE,
  script?: string
): ReturnType<typeof render> {
  const settings = settingsWithScript(script)
  mocks.storeSettings = settings
  return render(
    <RepositoryAddScriptSetting
      settings={settings}
      updateSettingsOrThrow={mocks.updateSettingsOrThrow}
      hostScope={hostScope}
    />
  )
}

function textbox(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Repository add script' })
}

function actionButton(name: string): HTMLButtonElement {
  const button = screen.getByRole('button', { name })
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected "${name}" to be a button`)
  }
  return button
}

beforeEach(() => {
  mocks.webClient = false
  mocks.runtimeEnvironments = [
    { id: 'ssh-host', name: 'SSH Host', createdAt: 1, pairingRevision: 17 }
  ]
  mocks.updateSettingsOrThrow.mockReset()
  mocks.read.mockReset()
  mocks.write.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('repository add script local editor', () => {
  it('saves through the settings action and backfills the authoritative store value', async () => {
    mocks.updateSettingsOrThrow.mockImplementation(async (updates: Partial<GlobalSettings>) => {
      // Why: the real action writes the host echo into the store; the editor must re-read it.
      mocks.storeSettings = {
        ...settingsWithScript(updates.repositoryAddScript),
        repositoryAddScript: 'echo from host'
      }
    })
    renderSetting(LOCAL_SCOPE, 'echo saved')

    fireEvent.change(textbox(), { target: { value: 'echo edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.updateSettingsOrThrow).toHaveBeenCalledWith({
        repositoryAddScript: 'echo edited'
      })
    )
    await waitFor(() => expect(textbox().value).toBe('echo from host'))
    expect(mocks.storeSettings?.repositoryAddScript).toBe('echo from host')
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })

  it('keeps text typed during a save and does not claim it was saved', async () => {
    let finishSave!: () => void
    mocks.updateSettingsOrThrow.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            mocks.storeSettings = settingsWithScript('echo from host')
            resolve()
          }
        })
    )
    renderSetting(LOCAL_SCOPE, 'echo saved')
    fireEvent.change(textbox(), { target: { value: 'echo submitted' } })
    fireEvent.click(actionButton('Save'))
    await waitFor(() =>
      expect(mocks.updateSettingsOrThrow).toHaveBeenCalledWith({
        repositoryAddScript: 'echo submitted'
      })
    )

    fireEvent.change(textbox(), { target: { value: 'echo typed during save' } })
    await act(async () => finishSave())

    expect(textbox().value).toBe('echo typed during save')
    expect(screen.queryByRole('status')).toBeNull()
    expect(mocks.storeSettings?.repositoryAddScript).toBe('echo from host')
  })

  it('adopts an externally changed setting while the draft is clean', async () => {
    const view = renderSetting(LOCAL_SCOPE, 'echo saved')
    mocks.updateSettingsOrThrow.mockImplementation(async (updates: Partial<GlobalSettings>) => {
      mocks.storeSettings = settingsWithScript(updates.repositoryAddScript)
    })
    fireEvent.change(textbox(), { target: { value: 'echo local' } })
    fireEvent.click(actionButton('Save'))
    await screen.findByRole('status')

    const external = settingsWithScript('echo external')
    mocks.storeSettings = external
    view.rerender(
      <RepositoryAddScriptSetting
        settings={external}
        updateSettingsOrThrow={mocks.updateSettingsOrThrow}
        hostScope={LOCAL_SCOPE}
      />
    )

    expect(textbox().value).toBe('echo external')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('does not overwrite unsaved edits when the setting changes externally', () => {
    const view = renderSetting(LOCAL_SCOPE, 'echo saved')
    fireEvent.change(textbox(), { target: { value: 'echo dirty' } })
    const external = settingsWithScript('echo external')
    mocks.storeSettings = external

    view.rerender(
      <RepositoryAddScriptSetting
        settings={external}
        updateSettingsOrThrow={mocks.updateSettingsOrThrow}
        hostScope={LOCAL_SCOPE}
      />
    )

    expect(textbox().value).toBe('echo dirty')
  })

  it('clears the script by sending empty text and backfilling the store', async () => {
    mocks.updateSettingsOrThrow.mockImplementation(async (updates: Partial<GlobalSettings>) => {
      mocks.storeSettings = settingsWithScript(updates.repositoryAddScript)
    })
    renderSetting(LOCAL_SCOPE, 'echo saved')

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))

    await waitFor(() =>
      expect(mocks.updateSettingsOrThrow).toHaveBeenCalledWith({ repositoryAddScript: '' })
    )
    await waitFor(() => expect(textbox().value).toBe(''))
    expect(mocks.storeSettings?.repositoryAddScript).toBe('')
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })

  it('keeps the typed script and shows an inline error when saving fails', async () => {
    mocks.updateSettingsOrThrow.mockRejectedValue(new Error('offline'))
    renderSetting(LOCAL_SCOPE, 'echo saved')
    fireEvent.change(textbox(), { target: { value: 'echo kept' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(textbox().value).toBe('echo kept')
    expect(alert.textContent).toContain('Couldn’t save the script')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disables saving but keeps Clear available when the initial script is too long', () => {
    renderSetting(LOCAL_SCOPE, 'x'.repeat(REPOSITORY_ADD_SCRIPT_MAX_LENGTH + 1))

    expect(textbox().getAttribute('maxlength')).toBe(String(REPOSITORY_ADD_SCRIPT_MAX_LENGTH))
    expect(actionButton('Save').disabled).toBe(true)
    expect(actionButton('Clear').disabled).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain(
      String(REPOSITORY_ADD_SCRIPT_MAX_LENGTH)
    )
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('labels the textarea and ties its description to the control', () => {
    renderSetting(LOCAL_SCOPE, 'echo saved')

    expect(screen.getByLabelText('Repository add script')).toBe(textbox())
    expect(textbox().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('says local editing is unavailable in the web client without reading or writing', () => {
    mocks.webClient = true
    renderSetting(LOCAL_SCOPE, 'echo saved')

    expect(screen.getByText(/can’t be edited from the web client/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })
})

describe('repository add script host editor', () => {
  it('refuses to edit a remote host script in the web client without reading it', () => {
    mocks.webClient = true
    renderSetting(REMOTE_SCOPE)

    expect(screen.getByText(/can’t be edited from the web client/)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('says an old server needs an update instead of reading the script', async () => {
    mocks.read.mockResolvedValue(null)
    renderSetting(REMOTE_SCOPE)

    await screen.findByText('Update this server to edit its repository add script.')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('reads the chosen host, names it, and backfills the saved response', async () => {
    mocks.read.mockResolvedValue('echo host')
    mocks.write.mockResolvedValue('echo normalized')
    renderSetting(REMOTE_SCOPE)

    await screen.findByDisplayValue('echo host')
    expect(screen.getByText(/on SSH Host/)).toBeTruthy()

    fireEvent.change(textbox(), { target: { value: 'echo edited' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(mocks.write).toHaveBeenCalledWith(
        { environmentId: 'ssh-host', pairingRevision: 17 },
        'echo edited',
        expect.any(AbortSignal)
      )
    )
    await waitFor(() => expect(textbox().value).toBe('echo normalized'))
    expect(screen.getByRole('status').textContent).toBe('Saved')
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('retries a failed read without falling back to desktop settings', async () => {
    mocks.read.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('echo host')
    renderSetting(REMOTE_SCOPE)

    await screen.findByText(/Couldn’t read the repository add script/)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByDisplayValue('echo host')
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('says a removed server is unavailable without showing another host', () => {
    mocks.runtimeEnvironments = []
    renderSetting({ ...REMOTE_SCOPE, available: false })

    expect(screen.getByText(/This server is no longer saved/)).toBeTruthy()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.updateSettingsOrThrow).not.toHaveBeenCalled()
  })

  it('waits for the server list instead of showing desktop settings', () => {
    mocks.runtimeEnvironments = []
    renderSetting(REMOTE_SCOPE)

    expect(screen.getByText('Loading repository add script…')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('keeps the typed script and shows an inline error when a host write fails', async () => {
    mocks.read.mockResolvedValue('echo host')
    mocks.write.mockRejectedValue(new Error('offline'))
    renderSetting(REMOTE_SCOPE)

    await screen.findByDisplayValue('echo host')
    fireEvent.change(textbox(), { target: { value: 'echo kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(textbox().value).toBe('echo kept')
    expect(alert.textContent).toContain('Couldn’t save the script')
  })

  it('disables both actions while a write is pending, then allows the next one', async () => {
    let finishWrite!: (script: string) => void
    mocks.read.mockResolvedValue('echo host')
    mocks.write.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishWrite = resolve
        })
    )
    renderSetting(REMOTE_SCOPE)

    await screen.findByDisplayValue('echo host')
    fireEvent.change(textbox(), { target: { value: 'echo first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))

    const save = actionButton('Save')
    const clear = actionButton('Clear')
    expect(save.disabled).toBe(true)
    expect(clear.disabled).toBe(true)

    await act(async () => finishWrite('echo first'))
    await waitFor(() => expect(save.disabled).toBe(false))

    mocks.write.mockResolvedValue('')
    fireEvent.click(clear)
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2))
    expect(mocks.write.mock.calls[1]?.[1]).toBe('')
  })

  it('keeps text typed during a host save and does not claim it was saved', async () => {
    let finishWrite!: (script: string) => void
    mocks.read.mockResolvedValue('echo host')
    mocks.write.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishWrite = resolve
        })
    )
    renderSetting(REMOTE_SCOPE)

    await screen.findByDisplayValue('echo host')
    fireEvent.change(textbox(), { target: { value: 'echo submitted' } })
    fireEvent.click(actionButton('Save'))
    await waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(1))

    fireEvent.change(textbox(), { target: { value: 'echo typed during save' } })
    await act(async () => finishWrite('echo normalized'))

    expect(textbox().value).toBe('echo typed during save')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('aborts the host read when the editor unmounts', async () => {
    let finishRead!: (script: string) => void
    mocks.read.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishRead = resolve
        })
    )
    const { unmount } = renderSetting(REMOTE_SCOPE)
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1))
    const signal: AbortSignal = mocks.read.mock.calls[0]?.[1]

    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finishRead('late'))
  })
})
