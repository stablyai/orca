// #29456: phone listings must reach converted SSH projects through mobileRelay.hosts.*, while desktop retains hidden relay rows.
// Pin the real phone wire here; mobile host-server-workspaces-wiring/workspace-route tests cover rendered rows and call tags.
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import {
  launchConvertedProfile,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileSocket } from './helpers/paired-mobile-client'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../src/shared/mobile-desktop-relay-contract'

skipUnlessManagedDockerHost()

const StatusSchema = z.looseObject({ capabilities: z.array(z.string()) })
const WorktreeListSchema = z.looseObject({
  worktrees: z.array(z.looseObject({ worktreeId: z.string(), path: z.string() }))
})
const HostsSchema = z.object({
  hosts: z.array(
    z.looseObject({
      hostId: z.string(),
      label: z.string(),
      health: z.string(),
      relay: z.string()
    })
  )
})
const HostWorktreesSchema = z.object({
  worktrees: z
    .array(
      z.looseObject({
        worktreeId: z.string(),
        path: z.string(),
        hostId: z.string()
      })
    )
    .nullable()
})
const DirectorySchema = z.array(z.looseObject({ name: z.string() }))

let requestId = 0
async function phoneCall<T>(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  schema: z.ZodType<T>,
  executionHost?: string
): Promise<T> {
  requestId += 1
  const id = `phone-${requestId}`
  socket.send(id, method, params, executionHost)
  let frame: PairedMobileSocket['frames'][number] | undefined
  await expect
    .poll(() => (frame = socket.frames.find((entry) => entry.id === id)), {
      timeout: 60_000
    })
    .toBeDefined()
  expect(frame!.ok, `${method}: ${JSON.stringify(frame!.error)}`).toBe(true)
  return schema.parse(frame!.result)
}

test("a paired phone lists and opens the projects on the desktop's managed SSH host", async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(12 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { page, seeded, environmentId } = await launchConvertedProfile(fixture)
    const serverHostId = toRuntimeExecutionHostId(environmentId)
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(page))
    const socket = await phone.openSocket()
    try {
      const status = await phoneCall(socket, 'status.get', {}, StatusSchema)
      expect(status.capabilities).toContain(MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY)

      // The desktop's own list: what a page without server rows shows. The relay-era copies stay hidden.
      const own = await phoneCall(socket, 'worktree.ps', { limit: 1_000 }, WorktreeListSchema)
      expect(own.worktrees.map((row) => row.path)).not.toContain(seeded.repoPath)

      // The SSH host listed once, under its SSH name, as the managed server the phone can reach.
      const { hosts } = await phoneCall(socket, 'mobileRelay.hosts.list', {}, HostsSchema)
      const sshLabel = fixture.host.input.label
      expect(hosts).toEqual([
        expect.objectContaining({
          hostId: serverHostId,
          label: sshLabel,
          relay: 'ready'
        })
      ])

      let listed: z.infer<typeof HostWorktreesSchema>['worktrees'] = null
      await expect
        .poll(
          async () => {
            listed = (
              await phoneCall(
                socket,
                'mobileRelay.hosts.worktrees',
                { hostId: serverHostId },
                HostWorktreesSchema
              )
            ).worktrees
            return listed?.map((row) => row.path) ?? []
          },
          { timeout: 60_000 }
        )
        .toContain(seeded.repoPath)
      const project = listed!.find((row) => row.path === seeded.repoPath)!
      expect(project.hostId).toBe(serverHostId)

      // Opening the project reads it on the server, through the desktop.
      const entries = await phoneCall(
        socket,
        'files.readDir',
        { worktree: `id:${project.worktreeId}`, relativePath: '' },
        DirectorySchema,
        serverHostId
      )
      expect(entries.length).toBeGreaterThan(0)
    } finally {
      socket.close()
      phone.dispose()
    }
  })
})
