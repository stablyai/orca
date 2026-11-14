import type { Sentence } from './agent-session-failure-words'
import { quotingPersonDetail } from './agent-session-failure-quoted-detail'

export const commandFailureSentences = {
  reviewSettingsUnsupported: ((_context, fact, _surface, say) =>
    say('reviewSettingsUnsupported', {
      detail: fact.detail?.text ?? 'the model last used in this chat'
    })) satisfies Sentence,
  reviewFailed: ((_context, _fact, _surface, say) => say('reviewFailed')) satisfies Sentence,
  compactionFailed: ((_context, fact, _surface, say) =>
    quotingPersonDetail(
      say,
      'compactionFailed',
      'compactionFailedQuoted',
      fact.detail
    )) satisfies Sentence,
  compactionUnconfirmed: ((_context, _fact, _surface, say) =>
    say('compactionUnconfirmed')) satisfies Sentence
}
