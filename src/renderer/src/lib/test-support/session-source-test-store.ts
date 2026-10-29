import type { AppState } from '../../store/types'
import {
  withSessionSourceWrites,
  type SessionStateCreator
} from '../../store/session-source-write-boundary'
import { SESSION_SOURCE_KINDS } from '../session-source-fields'
import { observeSessionSourceOracle } from './session-source-oracle'

/** Slice fixtures keep the production source domains and check every accepted notification. */
export function withSessionSourceTestWrites<S extends Partial<AppState> = AppState>(
  createState: SessionStateCreator<S>
) {
  return withSessionSourceWrites<S>((...args) => {
    const collections = Object.fromEntries(
      Object.entries(SESSION_SOURCE_KINDS).flatMap(([field, kind]) =>
        kind === 'sequence' ? [[field, []]] : []
      )
    )
    const state = createState(...args)
    observeSessionSourceOracle(args[2])
    return { ...collections, ...state }
  }, true)
}
