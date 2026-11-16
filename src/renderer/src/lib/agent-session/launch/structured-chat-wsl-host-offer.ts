// A chat refused in a Windows-opened WSL folder runs once its project moves onto a WSL host.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { readWslHostOfferGate } from '@/components/sidebar/wsl-host-offer'
import { runWslDistroAsHost } from '@/components/sidebar/wsl-host-offer-actions'
import { addWslHostDistro } from '@/components/sidebar/host-admission/wsl/add-wsl-host-distro'
import { wslHostAddRefusalMessage } from '@/components/sidebar/wsl-host-failure-text'
import { openWslMoveDialogFor } from '@/components/wsl-move/wsl-move-entry'
import {
  findWslHostForDistro,
  wslMoveProjectOfWorkspace
} from '@/components/wsl-move/wsl-move-scope-rows'
import type { WslMoveRowRef } from '../../../../../shared/wsl-move/wsl-move-driver-types'

/** Flat so a shallow-compared selector can return it. */
export type WslHostChatOffer = {
  distro: string
  projectKind: WslMoveRowRef['kind']
  projectId: string
  /** The distro is already a host and the setting is on, so only the move remains. */
  hostReady: boolean
}

export type WslHostChatAction = { label: string; primary: true; onClick: () => void }

/** This workspace's local WSL project, while this desktop can add WSL hosts; else null. */
export type WslHostChatOfferState = Parameters<typeof readWslHostOfferGate>[0] & {
  repos: Parameters<typeof wslMoveProjectOfWorkspace>[0]['repos']
  folderWorkspaces?: Parameters<typeof wslMoveProjectOfWorkspace>[0]['folders']
  runtimeEnvironments: Parameters<typeof findWslHostForDistro>[0]
}

export function readWslHostChatOffer(
  state: WslHostChatOfferState,
  worktreeId: string | null | undefined
): WslHostChatOffer | null {
  if (!worktreeId || !readWslHostOfferGate(state).gateOpen) {
    return null
  }
  const project = wslMoveProjectOfWorkspace(
    { repos: state.repos, folders: selectFolderWorkspaces(state) ?? [] },
    worktreeId
  )
  if (!project) {
    return null
  }
  return {
    distro: project.distro,
    projectKind: project.ref.kind,
    projectId: project.ref.id,
    hostReady:
      state.settings?.experimentalWslHosts === true &&
      findWslHostForDistro(state.runtimeEnvironments, project.distro) !== null
  }
}

export function wslHostChatOfferText(t: Translate = translate): string {
  return t(
    'components.native-chat.explicitChatWslMoveToHost',
    'Chat is not available in a WSL folder opened from Windows. Run the project on a WSL host to chat there, or open the agent in a terminal.'
  )
}

/** Turns the setting on and adds the distro when needed, then opens the move for this project. */
export function wslHostChatOfferAction(
  offer: WslHostChatOffer,
  t: Translate = translate
): WslHostChatAction {
  const only: WslMoveRowRef = { kind: offer.projectKind, id: offer.projectId }
  return {
    label: offer.hostReady
      ? t('wslMove.entry.projectMenu', 'Move to {{distro}} host…', { distro: offer.distro })
      : t('components.native-chat.explicitChatWslRunAsHost', 'Run {{distro}} as a host', {
          distro: offer.distro
        }),
    primary: true,
    onClick: () => void runWslHostChatOffer(offer.hostReady, offer.distro, only)
  }
}

async function runWslHostChatOffer(
  hostReady: boolean,
  distro: string,
  only: WslMoveRowRef
): Promise<void> {
  if (!hostReady) {
    const adding = toast.loading(
      translate(
        'auto.components.sidebar.AddWslHostFormPanel.addingHint',
        'Installing and starting the Orca server in the distro. The first time can take a minute.'
      )
    )
    try {
      const refusal = await runWslDistroAsHost(distro, {
        readWslHostsSetting: () => useAppStore.getState().settings?.experimentalWslHosts === true,
        updateSettings: (updates) => useAppStore.getState().updateSettingsOrThrow(updates),
        addWslHost: addWslHostDistro
      })
      if (refusal) {
        toast.error(wslHostAddRefusalMessage(refusal))
        return
      }
    } catch (cause) {
      toast.error(readIpcErrorDetail(cause) ?? String(cause))
      return
    } finally {
      toast.dismiss(adding)
    }
  }
  // The user's Move in the dialog is what moves the project.
  openWslMoveDialogFor(distro, only)
}
