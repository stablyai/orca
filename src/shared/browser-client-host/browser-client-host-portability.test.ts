import { build } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult,
  type BrowserClientHostLeaseAuthority
} from '../browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'

const authority: BrowserClientHostLeaseAuthority = {
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-a',
  browserHostClientId: 'phone-a',
  browserHostGeneration: 1,
  pageCommandProtocolVersion: 1,
  supportedAutomationMethods: ['browser.snapshot']
}

describe('portable browser command dispatcher', () => {
  it('bundles for a browser without desktop or Node runtime dependencies', async () => {
    const bundle = await build({
      entryPoints: ['src/shared/browser-client-host/browser-client-host-command-dispatcher.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true
    })
    expect(bundle.outputFiles).toHaveLength(1)
    expect(Object.keys(bundle.metafile.inputs).some((file) => file.startsWith('src/main/'))).toBe(
      false
    )
  })

  it('replays phone page creation and exposes the existing automation replay limitation', async () => {
    let complete = (_result: BrowserClientHostCommandResult): void => {}
    const pending = new Promise<BrowserClientHostCommandResult>((resolve) => {
      complete = resolve
    })
    const handler = vi.fn((_event: BrowserClientHostCommandEvent) => pending)
    const dispatcher = new BrowserClientHostCommandDispatcher({ authority, handler })
    const create = event(1, {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'ssh:host-a',
      workspaceId: 'folder:workspace-a'
    })
    const creating = dispatcher.dispatch(create)
    expect(dispatcher.dispatch(create)).toBe(creating)
    expect(handler.mock.calls[0]?.[0].command).toEqual(create.command)
    complete({ status: 'completed' })
    await creating
    expect(await dispatcher.dispatch(create)).toBe(await creating)

    const result: BrowserClientHostCommandResult = {
      status: 'completed',
      value: { snapshot: 'button Submit', refs: { e1: { role: 'button', name: 'Submit' } } }
    }
    handler.mockResolvedValue(result)
    const snapshot = event(2, {
      type: 'automation',
      method: 'browser.snapshot',
      params: { interactive: true }
    })
    const first = await dispatcher.dispatch(snapshot)
    expect(first).toEqual(result)
    // Existing automation matching fails closed; extracting it must not silently change replay.
    expect(() => dispatcher.dispatch(snapshot)).toThrow('browser_host_command_sequence_conflict')
    expect(handler).toHaveBeenCalledTimes(2)
    expect(() => dispatcher.dispatch({ ...snapshot, authorityEpoch: 'replaced-epoch' })).toThrow(
      'browser_host_command_authority_stale'
    )
    expect(handler).toHaveBeenCalledTimes(2)
    await dispatcher.close()
  })
})

function event(
  sequence: number,
  command: BrowserClientHostCommandEvent['command']
): BrowserClientHostCommandEvent {
  return BrowserClientHostCommandEvent.parse({
    ...authority,
    type: 'command',
    browserPageId: 'page-a',
    pageHostGeneration: 1,
    commandSequence: sequence,
    commandId: `command-${sequence}`,
    command
  })
}
