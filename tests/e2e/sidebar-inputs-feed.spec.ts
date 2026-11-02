import { test, expect } from './helpers/orca-app'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-shadow'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient, type PairedMobileSocket } from './helpers/paired-mobile-client'
import type { SidebarInputsReadResult } from '../../src/shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReplied,
  type SidebarInputsFeedState,
  type SidebarInputsFeedStep
} from '../../src/shared/sidebar-list/sidebar-inputs-feed-installer'

/** Sends each read the installer asks for over the phone's one socket until none is left. */
async function settle(socket: PairedMobileSocket, step: SidebarInputsFeedStep) {
  const kinds: string[] = []
  let { state, request } = step
  while (request) {
    const frameId = `feed-${request.id}`
    socket.send(frameId, 'sidebarInputs.read', request.params)
    await expect.poll(() => socket.frames.some((frame) => frame.id === frameId)).toBe(true)
    const frame = socket.frames.find((candidate) => candidate.id === frameId)
    expect(frame, JSON.stringify(frame?.error)).toMatchObject({ ok: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an ok sidebarInputs.read frame carries its result.
    const reply = frame?.result as SidebarInputsReadResult
    kinds.push(reply.kind)
    ;({ state, request } = sidebarInputsReplied(state, request.id, reply))
  }
  return { state, kinds }
}

function pinned(state: SidebarInputsFeedState): unknown {
  return state.installed?.domains.get('desktop')?.get('pinnedWorkspaceIds')
}

test.describe('switch on', () => {
  test.skip(
    !SIDEBAR_INPUTS_BUILD,
    'sidebarInputs.read exists only in an ORCA_SIDEBAR_INPUTS=main build'
  )

  test('the host’s own phone reads a whole snapshot, then a delta after a change', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    try {
      const socket = await phone.openSocket()
      socket.send('events', 'runtime.clientEvents.subscribe', null)

      const first = await settle(socket, refreshSidebarInputs(INITIAL_SIDEBAR_INPUTS_FEED_STATE))
      expect(first.kinds.every((kind) => kind === 'snapshot')).toBe(true)
      const installed = first.state.installed
      expect(installed?.domains.get('temporal')?.has('sortSnapshot')).toBe(true)
      expect(pinned(first.state)).not.toContain(worktreeId)

      await orcaPage.evaluate(
        (id) =>
          window.api.runtime.call({
            method: 'worktree.set',
            params: { worktree: `id:${id}`, isPinned: true }
          }),
        worktreeId
      )
      const notice = (): { generation: string; revision: number } | undefined =>
        socket.frames
          .map((frame) => frame.result)
          .findLast(
            (
              result
            ): result is { type: 'sidebarInputsChanged'; generation: string; revision: number } =>
              typeof result === 'object' &&
              result !== null &&
              'type' in result &&
              result.type === 'sidebarInputsChanged' &&
              'revision' in result &&
              typeof result.revision === 'number' &&
              result.revision > (installed?.revision ?? 0)
          )
      await expect.poll(() => notice() !== undefined).toBe(true)
      const event = notice()
      if (!event) {
        throw new Error('no change notice')
      }
      const second = await settle(socket, sidebarInputsChanged(first.state, event))
      expect(second.kinds).toEqual(['delta'])
      expect(second.state.installed?.generation).toBe(installed?.generation)
      expect(pinned(second.state)).toContain(worktreeId)
    } finally {
      phone.dispose()
    }
  })
})

test.describe('switch off', () => {
  test.skip(SIDEBAR_INPUTS_BUILD, 'checks the shipped method set')

  test('a switch-off build refuses sidebarInputs.read to the phone', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    try {
      const response = await phone.request('sidebarInputs.read', { maxBytes: 262_144 })
      expect(response).toMatchObject({ ok: false })
    } finally {
      phone.dispose()
    }
  })
})
