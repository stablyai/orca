import { useMemo, useSyncExternalStore } from 'react'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import {
  sessionOptionDispatchUnconfirmed,
  type SessionOptionDescriptor,
  type SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'

export const MODEL_PRESET_SLOTS = [1, 2, 3] as const
export type ModelPresetSlot = (typeof MODEL_PRESET_SLOTS)[number]
const schema = z.object({
  model: z.string().min(1),
  modelLabel: z.string(),
  effort: z.string().optional(),
  effortLabel: z.string().optional(),
  speed: z
    .discriminatedUnion('id', [
      z.object({ id: z.literal('fastMode'), value: z.boolean() }),
      z.object({ id: z.literal('serviceTier'), value: z.string().min(1), label: z.string() })
    ])
    .optional()
})
export type NativeChatModelPreset = z.infer<typeof schema>
export function sameNativeChatModelPreset(
  left: NativeChatModelPreset | null | undefined,
  right: NativeChatModelPreset | null | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.speed?.id === right.speed?.id &&
    left.speed?.value === right.speed?.value
  )
}
const presetsSchema = z.array(schema.nullable()).length(3)
const changedEvent = 'orca:model-presets-changed'
const storageKey = (scope: string): string => `orca.chat.modelPresets.v1:${scope}`

function readStored(scope: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(scope))
  } catch {
    return null
  }
}

function parseStored(raw: string | null): (NativeChatModelPreset | null)[] {
  try {
    const parsed = presetsSchema.safeParse(raw ? JSON.parse(raw) : null)
    if (!parsed.success) {
      return [null, null, null]
    }
    return parsed.data.map((preset, index, presets) =>
      presets.findIndex((candidate) => sameNativeChatModelPreset(candidate, preset)) === index
        ? preset
        : null
    )
  } catch {
    return [null, null, null]
  }
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(changedEvent, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(changedEvent, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useNativeChatModelPresets(scope: string | undefined) {
  const raw = useSyncExternalStore(subscribe, () => (scope ? readStored(scope) : null))
  const presets = useMemo(() => parseStored(raw), [raw])
  const save = (slot: ModelPresetSlot, preset: NativeChatModelPreset | null): boolean => {
    if (!scope) {
      return false
    }
    try {
      const next = parseStored(readStored(scope)).map((entry) =>
        sameNativeChatModelPreset(entry, preset) ? null : entry
      )
      next[slot - 1] = preset
      window.localStorage.setItem(storageKey(scope), JSON.stringify(next))
      window.dispatchEvent(new Event(changedEvent))
      return true
    } catch {
      return false
    }
  }
  return { presets, save }
}

export function currentNativeChatModelPreset(
  snapshot: readonly SessionOptionDescriptor[]
): NativeChatModelPreset | null {
  const selected = (id: string) => {
    const option = snapshot.find((entry) => entry.id === id)
    return option &&
      !option.action &&
      option.valueSource !== 'unknown' &&
      !sessionOptionDispatchUnconfirmed(option) &&
      option.kind.type === 'select'
      ? option.kind.choices.find((choice) => choice.value === option.kind.currentValue)
      : undefined
  }
  const model = selected('model')
  if (!model) {
    return null
  }
  const effort = selected('effort')
  if (snapshot.some((entry) => entry.id === 'effort') && !effort) {
    return null
  }
  const speedOption = snapshot.find(
    (entry) => entry.id === 'serviceTier' || entry.id === 'fastMode'
  )
  let speed: NativeChatModelPreset['speed']
  if (speedOption) {
    if (
      speedOption.action ||
      speedOption.valueSource === 'unknown' ||
      sessionOptionDispatchUnconfirmed(speedOption)
    ) {
      return null
    }
    if (speedOption.id === 'fastMode' && speedOption.kind.type === 'boolean') {
      speed = { id: 'fastMode', value: speedOption.kind.currentValue }
    } else if (speedOption.id === 'serviceTier') {
      const choice = selected('serviceTier')
      if (choice) {
        speed = { id: 'serviceTier', value: choice.value, label: choice.label }
      }
    }
    if (!speed) {
      return null
    }
  }
  return {
    model: model.value,
    modelLabel: model.label,
    ...(effort ? { effort: effort.value, effortLabel: effort.label } : {}),
    ...(speed ? { speed } : {})
  }
}

export async function applyNativeChatModelPreset(
  surface: SessionOptionsSurface,
  preset: NativeChatModelPreset,
  isWorking: boolean
): Promise<void> {
  const model = surface.getSnapshot().find((entry) => entry.id === 'model')
  if (
    !model?.settable ||
    model.action ||
    model.kind.type !== 'select' ||
    (isWorking && model.transport !== 'agent-session') ||
    !model.kind.choices.some((choice) => choice.value === preset.model)
  ) {
    throw new Error(
      translate(
        'components.native-chat.modelPresets.modelUnavailable',
        'This preset model is unavailable in the current session.'
      )
    )
  }
  let result = await surface.setOption('model', preset.model)
  if (preset.effort !== undefined) {
    // The target model owns its effort choices; the previous model's list may differ.
    const effort = result.snapshot.find((entry) => entry.id === 'effort')
    if (
      !effort?.settable ||
      effort.action ||
      effort.kind.type !== 'select' ||
      (isWorking && effort.transport !== 'agent-session') ||
      !effort.kind.choices.some((choice) => choice.value === preset.effort)
    ) {
      throw new Error(
        translate(
          'components.native-chat.modelPresets.effortUnavailable',
          'The model changed, but its saved effort is unavailable. Choose an effort in the model picker.'
        )
      )
    }
    result = await surface.setOption('effort', preset.effort)
  }
  if (preset.speed) {
    const speed = result.snapshot.find((entry) => entry.id === preset.speed?.id)
    if (
      !speed?.settable ||
      speed.action ||
      (isWorking && speed.transport !== 'agent-session') ||
      !(speed.kind.type === 'boolean'
        ? typeof preset.speed.value === 'boolean'
        : speed.kind.choices.some((choice) => choice.value === preset.speed?.value))
    ) {
      throw new Error(
        translate(
          'components.native-chat.modelPresets.speedUnavailable',
          'The model changed, but its saved speed is unavailable. Choose a speed in the model picker.'
        )
      )
    }
    await surface.setOption(preset.speed.id, preset.speed.value)
  }
}
