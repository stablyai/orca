import {
  applyNativeChatSessionOptionSettingsMutation,
  resolveStructuredLaunchSeedOptions
} from '../../../native-chat/input/session-options/native-chat-session-option-defaults'
import type { PersistedNativeChatSessionOptions } from '../../../native-chat/input/native-chat-session-options'
import { expect, it } from 'vitest'
import { createStructuredSessionSelectionController } from './structured-agent-session-selection-operations'

it.each([false, true])(
  'keeps Default after a dependent pick until an explicit model pick (full reply: %s)',
  (fullReply) => {
    let persisted: PersistedNativeChatSessionOptions = {}
    const controller = createStructuredSessionSelectionController((picks) => {
      persisted =
        applyNativeChatSessionOptionSettingsMutation(persisted, {
          type: 'apply-picks',
          agent: 'codex',
          picks
        }) ?? persisted
    })
    controller.setModelDefault(true)
    const effort = controller.issue('effort', 'high', 'configured-model')
    controller.settle(effort, {
      kind: 'accepted',
      options: fullReply ? { model: 'configured-model', effort: 'high' } : { effort: 'high' }
    })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toBeUndefined()
    const model = controller.issue('model', 'configured-model', null)
    controller.settle(model, { kind: 'accepted', options: { model: 'configured-model' } })
    expect(resolveStructuredLaunchSeedOptions(persisted, 'codex')).toEqual({
      model: 'configured-model',
      effort: 'high'
    })
  }
)
