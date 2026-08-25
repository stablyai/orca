import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import {
  createShortcutConnectionSlice,
  type ShortcutConnectionSlice
} from './shortcut-connection-slice'
import { createShortcutStoryReadSlice, type ShortcutStoryReadSlice } from './shortcut-story-slice'

export type ShortcutSlice = ShortcutConnectionSlice & ShortcutStoryReadSlice

export const createShortcutSlice: StateCreator<AppState, [], [], ShortcutSlice> = (...args) => ({
  ...createShortcutConnectionSlice(...args),
  ...createShortcutStoryReadSlice(...args)
})
