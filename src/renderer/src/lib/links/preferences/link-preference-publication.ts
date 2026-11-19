import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { noteLinkFieldsArrived } from './link-preference-operation'

export type LinkPreferenceFields = Partial<
  Pick<GlobalSettings, 'openLinksInApp' | 'httpLinkClickBehavior' | 'openLinksInAppPreferencePrompted'>
>

const LINK_PREFERENCE_KEYS = [
  'openLinksInApp',
  'httpLinkClickBehavior',
  'openLinksInAppPreferencePrompted'
] as const

export function linkFieldsOf(settings: Partial<GlobalSettings> | null | undefined): LinkPreferenceFields {
  const fields: LinkPreferenceFields = {}
  if (!settings) {
    return fields
  }
  if ('openLinksInApp' in settings) {
    fields.openLinksInApp = settings.openLinksInApp
  }
  if ('httpLinkClickBehavior' in settings) {
    fields.httpLinkClickBehavior = settings.httpLinkClickBehavior
  }
  if ('openLinksInAppPreferencePrompted' in settings) {
    fields.openLinksInAppPreferencePrompted = settings.openLinksInAppPreferencePrompted
  }
  return fields
}

function differs(current: GlobalSettings, arrived: LinkPreferenceFields): boolean {
  return LINK_PREFERENCE_KEYS.some((key) => key in arrived && current[key] !== arrived[key])
}

/** Delayed wholesale publications keep the link fields that already arrived; they are never newer. */
export function withCurrentLinkFields<T extends GlobalSettings | null>(
  next: T,
  current: GlobalSettings | null
): T {
  if (!next || !current) {
    return next
  }
  return { ...next, ...linkFieldsOf(current) }
}

type SettingsSetter<S extends { settings: GlobalSettings | null }> = (
  updater: (state: S) => S | { settings?: GlobalSettings | null }
) => void

/** A reply carries main's state at send time, so its link fields apply on arrival, before the generic fence can drop them. */
export function applyArrivedLinkFields<S extends { settings: GlobalSettings | null }>(
  set: SettingsSetter<S>,
  arrived: Partial<GlobalSettings> | null | undefined
): void {
  if (!arrived) {
    return
  }
  const fields = linkFieldsOf(arrived)
  let current: LinkPreferenceFields | null = null
  set((state) => {
    // Before the first full read there is nothing to keep fresh; that read publishes everything.
    if (!state.settings) {
      return state
    }
    if (!differs(state.settings, fields)) {
      current = linkFieldsOf(state.settings)
      return state
    }
    const settings: GlobalSettings = { ...state.settings, ...fields }
    current = linkFieldsOf(settings)
    return { settings }
  })
  if (current) {
    noteLinkFieldsArrived(current)
  }
}
