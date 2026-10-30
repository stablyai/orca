import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import type { TerminalPaneController } from '../terminal-pane/use-terminal-pane-controller'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  captureTerminalDropTarget,
  getCurrentTerminalDropTransport
} from '../terminal-pane/terminal-drop-target'
import { insertTerminalCrewMention } from '../terminal-pane/terminal-crew-mention'
import { useTerminalCrewIdentity } from './use-terminal-crew-identity'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'

type CrewPaneController = Pick<
  TerminalPaneController,
  | 'tabId'
  | 'worktreeId'
  | 'managerRef'
  | 'paneTransportsRef'
  | 'isRendererVisible'
  | 'expandedPaneId'
  | 'isolatedPaneKey'
  | 'managedPanes'
  | 'effectiveChatViewMode'
  | 'chatPane'
>

function TerminalCrewPortal({
  pane,
  controller
}: {
  pane: ManagedPane
  controller: CrewPaneController
}) {
  const { tabId, worktreeId, managerRef, paneTransportsRef } = controller
  const paneKey = makePaneKey(tabId, pane.leafId)
  const boundPtyId = useAppStore(
    (state) => state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  )
  const transport = paneTransportsRef.current.get(pane.id)
  const { target, party } = useTerminalCrewIdentity(
    paneKey,
    transport?.getPtyId() ?? boundPtyId,
    worktreeId
  )
  if (!target || !party || !transport) {
    return null
  }
  const captured = captureTerminalDropTarget(pane, transport)
  const hostKey = target.kind === 'local' ? 'local' : target.environmentId
  return createPortal(
    <OrchestrationCrewPanel
      target={target}
      party={party}
      isVisible={
        controller.isRendererVisible &&
        (controller.expandedPaneId === null || controller.expandedPaneId === pane.id) &&
        (controller.isolatedPaneKey === null || controller.isolatedPaneKey === paneKey)
      }
      canMention={transport.isConnected()}
      mention={(rows) => {
        const manager = managerRef.current
        const references = rows.flatMap((row) =>
          row.sendAddress ? [{ label: row.label, address: row.sendAddress, hostKey }] : []
        )
        if (manager) {
          const rejected = () =>
            toast.error(
              translate(
                'components.orchestrationCrew.mentionRejected',
                'The terminal did not accept the agent reference. Try again.'
              )
            )
          void insertTerminalCrewMention(
            manager,
            paneTransportsRef.current,
            captured,
            references
          ).then((accepted) => {
            if (!accepted) {
              rejected()
            } else if (
              managerRef.current === manager &&
              getCurrentTerminalDropTransport(manager, paneTransportsRef.current, captured)
            ) {
              manager.setActivePane(captured.paneId)
            }
          }, rejected)
        }
      }}
    />,
    pane.container,
    `crew-${pane.id}`
  )
}
export function TerminalCrewPortals({ controller }: { controller: CrewPaneController }) {
  return (
    <>
      {controller.managedPanes.map((pane) =>
        controller.effectiveChatViewMode && controller.chatPane?.id === pane.id ? null : (
          <TerminalCrewPortal key={pane.id} pane={pane} controller={controller} />
        )
      )}
    </>
  )
}
