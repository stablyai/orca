// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import {
  captureTerminalDropTarget,
  getCurrentTerminalDropTransport,
  getTerminalPaneVeilEnvironmentId
} from './terminal-drop-target'

it('blocks delivery of a native drop if the pane gains an outage veil after capture', () => {
  const pane = { id: 1, leafId: 'leaf-one', container: document.createElement('div') }
  const otherPane = { id: 2, leafId: 'leaf-two', container: document.createElement('div') }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the captured target lookup reads the manager.
  const manager = { getPanes: () => [pane, otherPane] } as unknown as PaneManager
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: target validation reads only connectivity and PTY identity.
  const transport = { getPtyId: () => 'pty-one', isConnected: () => true } as PtyTransport
  const transports = new Map([[pane.id, transport]])
  const target = captureTerminalDropTarget(pane, transport, { blockWhileVeiled: true })
  const veil = document.createElement('div')
  veil.setAttribute('data-remote-server-pane-veil', 'fixture-server')
  otherPane.container.append(veil)
  expect(getCurrentTerminalDropTransport(manager, transports, target)).toBe(transport)

  pane.container.append(veil)
  expect(getTerminalPaneVeilEnvironmentId(pane.container)).toBe('fixture-server')
  expect(getCurrentTerminalDropTransport(manager, transports, target)).toBeNull()

  veil.remove()
  expect(getCurrentTerminalDropTransport(manager, transports, target)).toBe(transport)
})
