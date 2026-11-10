import { queuedEditPublicationKey } from './queued-message-edit-publication'

const publicationKey = queuedEditPublicationKey

/** Count only publication-key reads, independently of the queue's normal card projection. */
export function countedQueuedEditPublication() {
  let reads = 0
  return {
    get reads() {
      return reads
    },
    reset: () => {
      reads = 0
    },
    key: (
      view: Parameters<typeof queuedEditPublicationKey>[0],
      sessionId: string,
      messageId: string | undefined
    ) =>
      publicationKey(
        {
          messages:
            view.messages?.map((entry) => ({
              ...entry,
              get messageId() {
                reads++
                return entry.messageId
              },
              get body() {
                reads++
                return entry.body
              }
            })) ?? null,
          cards: view.cards.map((entry) => ({
            get messageId() {
              reads++
              return entry.messageId
            }
          })),
          submissions: view.submissions?.map((entry) => ({
            ...entry,
            get queuedMessageId() {
              reads++
              return entry.queuedMessageId
            },
            get payloadFingerprint() {
              reads++
              return entry.payloadFingerprint
            }
          }))
        },
        sessionId,
        messageId
      )
  }
}
