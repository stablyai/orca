import { useAppStore } from '@/store/index'
import {
  withPerfNoticeOff,
  type PerfNoticeId
} from '../../../../shared/perf-notices/perf-notice-settings'

let writes: Promise<void> = Promise.resolve()

/** Writes queue, each built from the list the previous one saved, so two quick toggles both stick. */
export function setPerfNoticeOff(id: PerfNoticeId, off: boolean): Promise<void> {
  writes = writes.then(() => {
    const { settings, updateSettings } = useAppStore.getState()
    return updateSettings({ perfNoticesOff: withPerfNoticeOff(settings, id, off) })
  })
  return writes
}
