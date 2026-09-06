import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT,
  MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS,
  MobileWebNativeChatAttachImageResultSchema,
  MobileWebNativeChatPasteImagesPayloadSchema,
  MobileWebNativeChatReleaseImagesPayloadSchema,
  MobileWebNativeChatRespondPayloadSchema,
  MobileWebNativeChatSendMessagePayloadSchema,
  MobileWebNativeChatStopPayloadSchema
} from './native-chat-operation-contract'

const TARGET = {
  workspaceId: 'opaque-workspace',
  sessionId: `native_chat_0_${'01'.repeat(16)}`
}
const IMAGE_ID = `native_chat_image_0_${'02'.repeat(16)}`

describe('mobile web native-chat operation contract', () => {
  it('requires one bounded absolute deadline on every terminal mutation', () => {
    const deadline = Date.now() + 15_000

    expect(
      MobileWebNativeChatSendMessagePayloadSchema.safeParse({
        ...TARGET,
        text: 'hello',
        deadline,
        clearInputFirst: true
      }).success
    ).toBe(true)
    expect(
      MobileWebNativeChatRespondPayloadSchema.safeParse({
        ...TARGET,
        text: '1',
        enter: false,
        deadline
      }).success
    ).toBe(true)
    expect(MobileWebNativeChatStopPayloadSchema.safeParse({ ...TARGET, deadline }).success).toBe(
      true
    )
    expect(
      MobileWebNativeChatSendMessagePayloadSchema.safeParse({ ...TARGET, text: 'hello' }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatSendMessagePayloadSchema.safeParse({
        ...TARGET,
        text: 'hello',
        deadline,
        clearInputFirst: 'true'
      }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatStopPayloadSchema.safeParse({
        ...TARGET,
        deadline,
        timeoutMs: 15_000
      }).success
    ).toBe(false)
  })

  it('requires an opaque reference and bounded JPEG preview only when accepted', () => {
    const accepted = {
      status: 'accepted',
      attachment: {
        reference: IMAGE_ID,
        previewUri: 'data:image/jpeg;base64,preview'
      }
    }

    expect(MobileWebNativeChatAttachImageResultSchema.safeParse(accepted).success).toBe(true)
    expect(
      MobileWebNativeChatAttachImageResultSchema.safeParse({
        status: 'accepted',
        attachment: { ...accepted.attachment, reference: '/private/image.png' }
      }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatAttachImageResultSchema.safeParse({
        status: 'accepted',
        attachment: { ...accepted.attachment, previewUri: 'file:///private/preview.jpg' }
      }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatAttachImageResultSchema.safeParse({
        status: 'accepted',
        attachment: {
          ...accepted.attachment,
          previewUri: `data:image/jpeg;base64,${'x'.repeat(
            MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS
          )}`
        }
      }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatAttachImageResultSchema.safeParse({ status: 'accepted' }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatAttachImageResultSchema.safeParse({
        status: 'cancelled',
        attachment: accepted.attachment
      }).success
    ).toBe(false)
  })

  it('bounds opaque paste and release reference collections', () => {
    const references = Array.from(
      { length: MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT },
      (_, index) => `native_chat_image_${index.toString(36)}_${'03'.repeat(16)}`
    )
    const deadline = Date.now() + 15_000

    expect(
      MobileWebNativeChatPasteImagesPayloadSchema.safeParse({
        ...TARGET,
        references,
        deadline
      }).success
    ).toBe(true)
    expect(
      MobileWebNativeChatPasteImagesPayloadSchema.safeParse({
        ...TARGET,
        references: [...references, IMAGE_ID],
        deadline
      }).success
    ).toBe(false)
    expect(
      MobileWebNativeChatReleaseImagesPayloadSchema.safeParse({
        ...TARGET,
        references: []
      }).success
    ).toBe(false)
  })
})
