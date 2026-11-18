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
    case 'waiting for administrator permission':
      return t(
        'zotz.nodeSetup.detail.waitingForAdmin',
        'Accept the administrator prompt from Windows. It may be behind the Zotz window.'
      )
    case 'installing OpenSSH Server (this can take a few minutes)':
      return t(
        'zotz.nodeSetup.detail.installingSsh',
        'Installing OpenSSH Server through Windows Update. This usually takes 5 to 15 minutes.'
      )
    default:
      return step.detail
  }
}

/** What a running step is doing, so a long wait never looks frozen. */
export function zotzNodeSetupStepHint(id: ZotzNodeSetupStepId, t: Translate): string {
  switch (id) {
    case 'tailscale':
      return t(
        'zotz.nodeSetup.hint.tailscale',
        'Checking that Tailscale is installed and signed in; its address becomes the access link.'
      )
    case 'power':
      return t(
        'zotz.nodeSetup.hint.power',
        'Turning off sleep and hibernation while plugged in, and making the lid do nothing.'
      )
    case 'windowsUpdate':
      return t(
        'zotz.nodeSetup.hint.windowsUpdate',
        'Setting active hours so Windows Update never restarts the computer while you are signed in.'
      )
    case 'ssh':
      return t(
        'zotz.nodeSetup.hint.ssh',
        'Enabling the SSH server with key sign-in only. Windows downloads it the first time, so it can take a while; do not close Zotz.'
      )
    case 'firewall':
      return t(
        'zotz.nodeSetup.hint.firewall',
        'Opening the Zotz and SSH ports only to devices on your Tailscale network.'
      )
    case 'autostart':
      return t(
        'zotz.nodeSetup.hint.autostart',
        'Registering a task that opens Zotz at sign-in and restarts it if it stops.'
      )
    case 'keepAwake':
      return t('zotz.nodeSetup.hint.keepAwake', 'Keeping the computer awake while Zotz runs.')
    case 'networkExposure':
      return t(
        'zotz.nodeSetup.hint.networkExposure',
        'Opening the Zotz server to remote connections on your Tailscale address.'
      )
    case 'autologon':
      return t(
        'zotz.nodeSetup.hint.autologon',
        'Automatic sign-in is configured by hand with Sysinternals Autologon.'
      )
  }
}
