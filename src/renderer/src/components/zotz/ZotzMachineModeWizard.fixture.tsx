import type {
  ZotzNodeSetupProgress,
  ZotzNodeSetupStep
} from '../../../../shared/zotz/zotz-node-setup-contract'
import { defineFixture } from '../../component-fixtures/component-fixture'
import ZotzMachineModeWizard from './ZotzMachineModeWizard'

const FINISHED_STEPS: ZotzNodeSetupStep[] = [
  { id: 'tailscale', status: 'done', detail: '100.88.1.2' },
  { id: 'power', status: 'done', detail: 'AC: sleep never, hibernate never, lid does nothing' },
  { id: 'windowsUpdate', status: 'done' },
  { id: 'ssh', status: 'failed', detail: 'Add-WindowsCapability failed: no network' },
  { id: 'firewall', status: 'done', detail: 'TCP 6768 and 22 inbound only from 100.64.0.0/10' },
  { id: 'autostart', status: 'done' },
  { id: 'keepAwake', status: 'done' },
  { id: 'networkExposure', status: 'done', detail: 'port 6768' },
  {
    id: 'autologon',
    status: 'skipped',
    detail: 'manual',
    url: 'https://learn.microsoft.com/sysinternals/downloads/autologon'
  }
]

// 1x1 transparent PNG stands in for the pairing QR bitmap.
const QR_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const RUNNING_PROGRESS: ZotzNodeSetupProgress = {
  steps: [
    { id: 'tailscale', status: 'done', detail: '100.88.1.2' },
    { id: 'power', status: 'done', detail: 'AC: sleep never, hibernate never, lid does nothing' },
    { id: 'windowsUpdate', status: 'done' },
    {
      id: 'ssh',
      status: 'running',
      detail: 'installing OpenSSH Server (this can take a few minutes)'
    },
    { id: 'firewall', status: 'pending' },
    { id: 'autostart', status: 'pending' },
    { id: 'keepAwake', status: 'pending' },
    { id: 'networkExposure', status: 'pending' },
    { id: 'autologon', status: 'pending' }
  ],
  output: [
    '== tailscale ==',
    'tailscale -> done: 100.88.1.2',
    'Waiting for administrator permission (UAC)…',
    '== power ==',
    'power -> done: AC: sleep never, hibernate never, lid does nothing',
    '== windowsUpdate ==',
    'windowsUpdate -> done: active hours 6:00-0:00, no auto-restart while signed in',
    '== ssh ==',
    'installing OpenSSH Server (this can take a few minutes)'
  ]
}

function stubServerSetup(running = false): void {
  window.api.zotzNode = {
    autoShowFirstRun: false,
    onSetupProgress: (callback) => {
      if (running) {
        setTimeout(() => callback(RUNNING_PROGRESS), 0)
      }
      return () => {}
    },
    runServerSetup: running
      ? () => new Promise(() => {})
      : async () => ({ steps: FINISHED_STEPS, tailscaleIp: '100.88.1.2' }),
    removeAutostart: async () => ({ ok: true, removed: false, detail: '' })
  }
  window.api.mobile = {
    ...window.api.mobile,
    getRuntimePairingUrl: async () => ({
      available: true,
      pairingUrl: 'orca://pair?o=eyJ2IjozLCJlbmRwb2ludCI6IndzOi8vMTAwLjg4LjEuMjo2NzY4In0',
      webClientUrl: 'http://100.88.1.2:6768/#pair=eyJ2IjozfQ',
      endpoint: 'ws://100.88.1.2:6768',
      deviceId: 'device-1',
      expiresAt: null
    }),
    getPairingQR: async () => ({
      available: true,
      qrDataUrl: QR_PLACEHOLDER,
      qrSize: 1,
      pairingUrl: 'orca://pair?o=mobile',
      endpoint: 'ws://100.88.1.2:6768',
      deviceId: 'device-2',
      connectionMode: 'local-only',
      expiresAt: null
    })
  }
}

// Labels in English and Spanish, since fixtures render in the machine's language.
function clickButton(...labels: string[]): void {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    labels.some((label) => candidate.textContent?.includes(label))
  )
  button?.click()
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

export const choose = defineFixture({
  width: 720,
  render: () => <ZotzMachineModeWizard onClose={() => {}} onKeepOpen={() => {}} />
})

export const serverRunning = defineFixture({
  width: 720,
  store: { updateSettings: async () => {}, updateSettingsOrThrow: async () => {} },
  setup: () => stubServerSetup(true),
  render: () => <ZotzMachineModeWizard onClose={() => {}} onKeepOpen={() => {}} />,
  interact: async () => {
    clickButton('Remote server', 'Servidor remoto')
    await settle()
    clickButton('Set up server', 'Configurar servidor')
    await settle()
    await settle()
  }
})

export const serverFinished = defineFixture({
  width: 720,
  store: { updateSettings: async () => {}, updateSettingsOrThrow: async () => {} },
  setup: () => stubServerSetup(),
  render: () => <ZotzMachineModeWizard onClose={() => {}} onKeepOpen={() => {}} />,
  interact: async () => {
    clickButton('Remote server', 'Servidor remoto')
    await settle()
    clickButton('Set up server', 'Configurar servidor')
    await settle()
    await settle()
  }
})
