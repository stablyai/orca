// The line under an Orca-typed message's bubble while its Slack post goes, or once it failed.
import type { SlackMirrorPost } from './external-conversation-link'
import type { SlackMirrorCopy } from './slack-mirror-state'

/** The line under an Orca-typed message's bubble, if its post shows one. */
export function slackMirrorPostLine(
  post: SlackMirrorPost | undefined
): { kind: 'posting' | 'failed'; copy: SlackMirrorCopy } | null {
  if (post?.state === 'posting') {
    return {
      kind: 'posting',
      copy: { key: 'components.native-chat.slackMirror.posting', text: 'Posting to Slack…' }
    }
  }
  if (post?.state !== 'failed') {
    return null
  }
  if (post.error === 'empty') {
    return {
      kind: 'failed',
      copy: {
        key: 'components.native-chat.slackMirror.failedEmpty',
        text: 'Not posted to Slack · nothing to post'
      }
    }
  }
  // The cloud refuses a message it can't take (today: one over its text limit) as invalid.
  if (post.error === 'invalid_request') {
    return {
      kind: 'failed',
      copy: {
        key: 'components.native-chat.slackMirror.failedTooLong',
        text: 'Not posted to Slack · message too long'
      }
    }
  }
  return post.error === 'file_too_large'
    ? {
        kind: 'failed',
        copy: {
          key: 'components.native-chat.slackMirror.failedFile',
          text: 'Not posted to Slack · file too large'
        }
      }
    : {
        kind: 'failed',
        copy: { key: 'components.native-chat.slackMirror.failed', text: 'Not posted to Slack' }
      }
}
