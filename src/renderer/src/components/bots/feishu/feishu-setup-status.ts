import type { Translate } from '@/i18n/use-translate'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'

export function feishuSetupStatus(
  t: Translate,
  s: FeishuLocalState['status'],
  { sdk, off, groupEnabled }: { sdk: boolean; off: boolean; groupEnabled: boolean }
): string {
  switch (s) {
    case 'upload-permission':
      return t(
        'bots.feishu.uploadPermission',
        'Enable IM file upload under App identity (tenant), then publish the permission. A user-only grant cannot authorize bot uploads.'
      )
    case 'disconnect-failed':
      return t(
        'bots.feishu.disconnectFailed',
        'The listener has stopped. Disconnect again to release this app.'
      )
    case 'credentials-required':
      return t(
        'bots.feishu.credentialsRequired',
        'The host could not open the stored app secret. Disconnect and enter the credentials again.'
      )
    case 'off':
      if (sdk) {
        return t(
          'bots.feishu.sdkHelp',
          'Use the credentials from your Feishu app’s developer console. Orca stores the secret on the bot’s host.'
        )
      }
      return t(
        'bots.feishu.choose',
        'Choose a Feishu CLI profile on the computer that runs this bot.'
      )
    case 'cli-missing':
      if (!off || sdk) {
        return t(
          'bots.feishu.installReconnect',
          'Install lark-cli on the computer running this bot. Orca will retry the connection automatically.'
        )
      }
      return t(
        'bots.feishu.cliMissing',
        'Install lark-cli on the computer running this bot, then refresh profiles.'
      )
    case 'permission':
      return t(
        'bots.feishu.permission',
        'Grant the app permission to receive private messages and publish the updated app version. Orca will retry.'
      )
    case 'subscription':
      return t(
        'bots.feishu.subscription',
        'Subscribe to Receive message (im.message.receive_v1) using a long connection and publish the updated app version. Orca will retry.'
      )
    case 'profile-changed':
      return t(
        'bots.feishu.profileChanged',
        'The selected CLI profile no longer resolves to the paired app. Restore it or disconnect to choose another profile.'
      )
    case 'connecting':
      return t('bots.feishu.connecting', 'Starting the Feishu listener…')
    case 'verification-failed':
      return t(
        'bots.feishu.verificationFailed',
        'Could not verify the original DM. Check the app’s permission to read private messages, then send the code again.'
      )
    case 'pairing':
      return t(
        'bots.feishu.pairing',
        'Send this code from your own Feishu account in a direct message to the app. It expires in five minutes.'
      )
    case 'listening':
      return groupEnabled
        ? t(
            'bots.feishu.listeningGroup',
            'Listening to your verified DM and mentions from allowed members in the test group.'
          )
        : t(
            'bots.feishu.listening',
            'Listening for messages, images and files in your verified Feishu DM.'
          )
    case 'retrying':
      return t(
        'bots.feishu.retrying',
        'Retrying. Check the connection settings, app permissions and long-connection subscription.'
      )
    case 'paused':
      return t('bots.feishu.paused', 'This bot is paused or disabled.')
    case 'expired':
      return t('bots.feishu.expired', 'Pairing expired. Disconnect and pair again.')
    case 'review':
      return t(
        'bots.feishu.review',
        'A delivery could not be confirmed. Check the original Feishu message and the native chat before resending.'
      )
  }
}
