import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../component-fixtures/fixture-bots'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotGroupMembersDialog } from './BotGroupMembersDialog'
import { Toaster } from '../ui/sonner'
import { useState } from 'react'

// Bots on two computers: two here, two on a paired workstation. A group can hold only one computer's.
const WORKSTATION: ExecutionHostId = 'runtime:workstation'

function bot(id: string, name: string, mascot: BotMascotId): Bot {
  // A host stores its own bots as `local`; the listing stamps the host that read them.
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: mascotAvatar(mascot),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const here = [bot('star', 'Star 管家王', 'K2'), bot('notes', 'Release notes', 'H1')]
const away = [bot('dispatch', 'Workstation 管家', 'B1'), bot('builds', 'Nightly builds', 'F1')]
const PURPOSES: Record<string, string> = {
  star: '我是你的私人管家：盯住各台设备和各个项目，每天早上汇报进度',
  notes: 'Drafts release notes from merged pull requests',
  dispatch: '我负责接收、分配和监控各 agent 提交给 windows-workstation 的任务',
  builds: 'Runs the nightly build and reports failures'
}

/** The server makes the group, but its home isn't in the server's workspace list. */
function stubCreateWithoutHome(): void {
  const environments = window.api.runtimeEnvironments
  const call = environments.call.bind(environments)
  Reflect.set(window.api, 'runtimeEnvironments', {
    ...environments,
    call: async (request: Parameters<typeof call>[0]) =>
      request.method === 'bots.groups.create'
        ? {
            ok: true,
            result: {
              group: {
                id: 'crew',
                name: 'Night shift',
                hostId: 'local',
                revision: 1,
                folder: 'group-night-shift',
                folderWorkspaceId: 'fw-night-shift',
                createdAt: 1,
                members: [
                  { botId: 'dispatch', sessionId: 's-dispatch' },
                  { botId: 'builds', sessionId: 's-builds' }
                ],
                replyMode: { kind: 'mentions' }
              }
            }
          }
        : call(request)
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Dev mode runs a fixture's interact twice; both share one run per dialog so their clicks never interleave.
const runs = new WeakMap<Element, Promise<void>>()

function interactOnceFor(pick: string, opts: { createWithoutHome?: boolean }): Promise<void> {
  const dialog = document.querySelector('[role="dialog"]')
  if (!dialog) {
    return Promise.resolve()
  }
  const run = runs.get(dialog) ?? interactOnce(pick, opts)
  runs.set(dialog, run)
  return run
}

async function interactOnce(pick: string, opts: { createWithoutHome?: boolean }): Promise<void> {
  for (const name of pick.split('|')) {
    const row = [...document.querySelectorAll<HTMLElement>('[role="checkbox"]')].find((entry) =>
      entry.textContent?.includes(name)
    )
    row?.click()
    await pause(50)
  }
  if (!opts.createWithoutHome) {
    return
  }
  const input = document.querySelector<HTMLInputElement>('#bot-group-name')
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
    input,
    'Night shift'
  )
  input?.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(50)
  ;[...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent === 'Create')
    ?.click()
  for (let tries = 0; tries < 60 && !document.querySelector('[data-sonner-toast]'); tries++) {
    await pause(50)
  }
  await pause(500)
}

/** The dialog as the sidebar mounts it: it closes on success, and open failures come as toasts. */
function ClosingDialog(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <>
      {open ? (
        <BotGroupMembersDialog onClose={() => setOpen(false)} />
      ) : (
        <div className="h-[900px]" />
      )}
      <Toaster toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  )
}

function scene(pick?: string, opts: { createWithoutHome?: boolean } = {}) {
  return defineFixture({
    // A toast sits at the window's corner, so the toast scene shoots the whole window.
    width: opts.createWithoutHome ? 1280 : 560,
    store: {
      runtimeEnvironments: [
        {
          id: 'workstation',
          name: 'Workstation',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'workstation'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([
        [
          'workstation',
          { status: createCompatibleRuntimeStatusResponse('workstation').result, checkedAt: 1 }
        ]
      ]),
      ...(opts.createWithoutHome ? { fetchFolderWorkspaces: async () => {} } : {})
    },
    setup: () => {
      setBotHostListing({
        hosts: [
          { hostId: 'local', state: 'live' },
          { hostId: WORKSTATION, state: 'live' }
        ],
        updateNeeded: []
      })
      stubBots(here, PURPOSES)
      publishBots(away, { threadReplies: false, webhooks: undefined }, WORKSTATION)
      stubServerBots({ workstation: away }, {}, PURPOSES)
      if (opts.createWithoutHome) {
        stubCreateWithoutHome()
      }
    },
    render: () => (
      <ConfirmationDialogProvider>
        {opts.createWithoutHome ? <ClosingDialog /> : <BotGroupMembersDialog onClose={() => {}} />}
      </ConfirmationDialogProvider>
    ),
    interact: pick ? () => interactOnceFor(pick, opts) : undefined
  })
}

/** 1 · Bots on two computers: each row says which. */
export const twoComputers = scene()

/** 2 · A workstation bot picked: this computer's bots stay listed, dimmed, and the line says why. */
export const pickedOnWorkstation = scene('Workstation 管家')

/** 3 · The workstation made the group but can't find its home: the dialog closes, and the toast names both. */
export const homeUnavailable = scene('Workstation 管家|Nightly builds', { createWithoutHome: true })
