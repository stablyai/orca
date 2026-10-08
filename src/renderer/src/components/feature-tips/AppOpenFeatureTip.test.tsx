// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { selectDialogPhase } from '@/store/dialog-registry-state'
import { resetDialogRegistryForTests } from '@/store/dialog-registry-test-state'
import { getDefaultSettings } from '../../../../shared/constants'
import { AppOpenFeatureTip } from './AppOpenFeatureTip'
import { APP_OPEN_FEATURE_TIP_TOKEN } from './feature-tip-startup-gate'
import { SshPassphraseDialog } from '../settings/SshPassphraseDialog'
import { TooltipProvider } from '../ui/tooltip'

const terminal = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))
vi.mock('./CliSkillSetupTerminal', async () => {
  const { useEffect } = await import('react')
  return {
    // Stands in for the inline installer terminal, whose unmount closes its PTY tab.
    CliSkillSetupTerminal: () => {
      useEffect(() => {
        terminal.mounts += 1
        return () => {
          terminal.unmounts += 1
        }
      }, [])
      return <div data-testid="skill-terminal" />
    }
  }
})
vi.mock('./feature-tip-cli-install-action', () => ({
  installCliFromFeatureTip: vi.fn(async () => ({
    kind: 'installed',
    status: { state: 'installed', pathConfigured: true }
  }))
}))
vi.mock('./CliFeatureTipVisual', () => ({ CliFeatureTipVisual: () => null }))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

beforeAll(async () => {
  // Transform the real content before testing its lifecycle; lazy admission is covered separately.
  await import('./FeatureTipsModal')
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

/** The SSH prompt as the app hosts it. */
function SshHost(): React.JSX.Element | null {
  const asked = useAppStore((s) => s.sshCredentialQueue.length > 0)
  return asked ? <SshPassphraseDialog /> : null
}

beforeEach(() => {
  terminal.mounts = 0
  terminal.unmounts = 0
  resetDialogRegistryForTests({ startupSettled: true })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ settings: getDefaultSettings(''), persistedUIReady: true })
  Object.assign(window, {
    api: {
      cli: { install: vi.fn(async () => ({})) },
      ui: { set: vi.fn(async () => undefined) },
      ssh: { submitCredential: vi.fn(async () => undefined) }
    }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

it('closing keeps actual tip content until its exit ends and records seen only on commit', async () => {
  const markSeen = vi.fn(useAppStore.getState().markFeatureTipsSeen)
  useAppStore.setState({ markFeatureTipsSeen: markSeen })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AppOpenFeatureTip tipId="cmd-j-palette" />
      </TooltipProvider>
    )
  )
  await flush()
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
    timeout: 10_000
  })
  const content = document.querySelector<HTMLElement>('[data-slot="dialog-content"]')
  if (!content) {
    throw new Error('Tip content did not mount')
  }
  content.style.animationName = 'fade-out'
  act(() => useDialogRegistry.getState().enqueueAutomaticDialog('resume', 'native-chat-resume'))
  const acknowledge = [...content.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Got it')
  )
  await act(async () => acknowledge?.click())
  await flush()
  expect(content.isConnected).toBe(true)
  expect(content.getAttribute('data-state')).toBe('closed')
  expect(selectDialogPhase(useDialogRegistry.getState(), APP_OPEN_FEATURE_TIP_TOKEN)).toBe(
    'closing'
  )
  expect(selectDialogPhase(useDialogRegistry.getState(), 'resume')).toBe('queued')
  expect(markSeen).toHaveBeenCalledExactlyOnceWith(['cmd-j-palette'])
  const ended = new Event('animationend', { bubbles: true })
  Object.defineProperty(ended, 'animationName', { value: 'fade-out' })
  await act(async () => content.dispatchEvent(ended))
  expect(content.isConnected).toBe(false)
  expect(selectDialogPhase(useDialogRegistry.getState(), 'resume')).toBe('opening')
})

it('an SSH prompt and a user modal stack over the app-open tip, which keeps its setup terminal', async () => {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <AppOpenFeatureTip tipId="orca-cli" />
        <SshHost />
      </TooltipProvider>
    )
  )
  await flush()
  // Its code loads on first use.
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull(), {
    timeout: 10_000
  })
  await flush()
  expect(useAppStore.getState().featureTipsSeenIds).toEqual(['orca-cli'])
  const install = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Install CLI')
  )
  await act(async () => install?.click())
  await flush()
  expect(terminal).toEqual({ mounts: 1, unmounts: 0 })
  const tipDialog = document
    .querySelector('[data-testid="skill-terminal"]')
    ?.closest('[role="dialog"]')
  expect(tipDialog).toBeTruthy()

  act(() => {
    useAppStore.getState().enqueueSshCredentialRequest({
      requestId: 'r1',
      targetId: 't1',
      kind: 'passphrase',
      detail: '~/.ssh/id_ed25519'
    })
  })
  await flush()
  expect(document.body.textContent).toContain('SSH Key Passphrase')
  expect(tipDialog?.isConnected).toBe(true)
  await act(async () => useAppStore.getState().removeSshCredentialRequest('r1'))
  await flush()

  // Not in the modal slot, so a modal the user opens cannot replace it.
  act(() => useAppStore.getState().openModal('add-repo'))
  act(() => useAppStore.getState().closeModal())
  await flush()
  expect(tipDialog?.isConnected).toBe(true)
  expect(terminal).toEqual({ mounts: 1, unmounts: 0 })
})
