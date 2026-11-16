import type {
  ZotzNodeSetupStep,
  ZotzNodeSetupStepId
} from '../../../../shared/zotz/zotz-node-setup-contract'
import type { Translate } from '@/i18n/use-translate'

export function zotzNodeSetupStepTitle(id: ZotzNodeSetupStepId, t: Translate): string {
  switch (id) {
    case 'tailscale':
      return t('zotz.nodeSetup.step.tailscale', 'Tailscale connected')
    case 'power':
      return t('zotz.nodeSetup.step.power', 'Never sleep on power')
    case 'windowsUpdate':
      return t('zotz.nodeSetup.step.windowsUpdate', 'No automatic restarts while signed in')
    case 'ssh':
      return t('zotz.nodeSetup.step.ssh', 'SSH with keys only')
    case 'firewall':
      return t('zotz.nodeSetup.step.firewall', 'Firewall open to Tailscale only')
    case 'autostart':
      return t('zotz.nodeSetup.step.autostart', 'Start at sign-in and restart if it stops')
    case 'keepAwake':
      return t('zotz.nodeSetup.step.keepAwake', 'Keep this computer awake')
    case 'networkExposure':
      return t('zotz.nodeSetup.step.networkExposure', 'Accept remote connections')
    case 'autologon':
      return t('zotz.nodeSetup.step.autologon', 'Automatic sign-in (manual)')
  }
}

/** Main reports machine text; the details it emits on purpose get a translated phrase. */
export function zotzNodeSetupStepDetail(step: ZotzNodeSetupStep, t: Translate): string | null {
  switch (step.detail) {
    case undefined:
      return null
    case 'installing':
      return t('zotz.nodeSetup.detail.installing', 'Installing Tailscale…')
    case 'waiting for login':
      return t('zotz.nodeSetup.detail.waitingForLogin', 'Waiting for you to log in to Tailscale…')
    case 'manual':
      return t(
        'zotz.nodeSetup.detail.autologon',
        'Use Sysinternals Autologon so Windows signs in by itself after a restart. Zotz never asks for or stores your password.'
      )
    case 'administrator permission was declined':
      return t('zotz.nodeSetup.detail.declined', 'Administrator permission was declined.')
    case 'development build':
      return t('zotz.nodeSetup.detail.devBuild', 'Skipped in development builds.')
    default:
      return step.detail
  }
}
