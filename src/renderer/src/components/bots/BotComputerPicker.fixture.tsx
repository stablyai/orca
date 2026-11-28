import { defineFixture } from '../../component-fixtures/component-fixture'
import type { RemoteServerUpdateEntry } from '../../../../shared/remote-runtime/host-updates/remote-server-update-coordinator'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { BotComputerPicker } from './BotComputerPicker'
import type { BotCreateHost, BotCreateHostChoice } from './bot-create-hosts'

const server = (id: string, label: string, rest: Partial<BotCreateHost> = {}): BotCreateHost => ({
  hostId: `runtime:${id}`,
  label,
  environmentId: id,
  ...rest
})

const OWNER: BotCreateHost[] = [
  { hostId: LOCAL_EXECUTION_HOST_ID, label: 'Local Mac', platform: 'darwin' },
  server('g16', 'g16', { platform: 'win32', windows: true }),
  server('linux-box', 'linux-box', { platform: 'linux' }),
  server('linux-1', 'linux 1', { blocked: 'offline' }),
  server('m4', 'm4 air', { blocked: 'offline' }),
  server('windows-2', 'windows 2', { platform: 'win32', windows: true, blocked: 'no-bots' }),
  server('lab', 'lab-pc', { platform: 'linux', blocked: 'no-bots' })
]

const MANY: BotCreateHost[] = [
  ...OWNER.slice(0, 3),
  server('ci', 'ci-runner', { platform: 'linux' }),
  server('gpu', 'gpu-box', { platform: 'linux' }),
  ...OWNER.slice(3)
]

function choice(hosts: BotCreateHost[]): BotCreateHostChoice {
  return {
    hosts,
    host: hosts[0],
    setHostId: () => {},
    otherAccount: null,
    otherAccountOf: (hostId: ExecutionHostId) =>
      hostId === 'runtime:g16' ? 'team@acme.dev' : null,
    setListing: () => {},
    wslSetup: {
      state: { phase: 'idle' },
      start: () => {},
      retry: () => {},
      cancel: () => {},
      finish: () => {}
    },
    busy: false,
    reset: () => {}
  }
}

const update = (environmentId: string, phase: RemoteServerUpdateEntry['phase']) =>
  [
    environmentId,
    {
      environmentId,
      name: environmentId,
      phase,
      currentVersion: null,
      targetVersion: null,
      progress: null,
      runtimeId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      support: null,
      error: null
    }
  ] as const

const updates = new Map<string, RemoteServerUpdateEntry>([
  update('windows-2', 'available'),
  update('lab', 'current')
])

const open = async (): Promise<void> => {
  document.querySelector<HTMLElement>('[role="combobox"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 300))
}

const picker = (hosts: BotCreateHost[]) => (
  <div className="h-[300px] p-2">
    <BotComputerPicker hostChoice={choice(hosts)} />
  </div>
)

/** Ready hosts first, followed by hosts that need reconnecting or updating. */
export const owner = defineFixture({
  width: 420,
  store: { remoteServerUpdates: updates },
  render: () => picker(OWNER),
  interact: open
})

/** A longer, scrollable host list. */
export const many = defineFixture({
  width: 420,
  store: { remoteServerUpdates: updates },
  render: () => <div className="h-[380px] p-2">{picker(MANY)}</div>,
  interact: open
})

/** A narrow window: OS and account truncate before the name; the fix never drops. */
export const narrow = defineFixture({
  width: 300,
  store: { remoteServerUpdates: updates },
  render: () => picker(OWNER),
  interact: open
})
