import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  trelloListBoardLabels,
  trelloListBoardMembers,
  trelloListBoards,
  trelloListLists
} from '@/runtime/runtime-trello-client'
import type { TrelloSlice } from './trello-slice-contract'

type TrelloSliceSet = Parameters<StateCreator<AppState, [], [], TrelloSlice>>[0]
type TrelloSliceGet = Parameters<StateCreator<AppState, [], [], TrelloSlice>>[1]

export function createTrelloReferenceDataActions(
  set: TrelloSliceSet,
  get: TrelloSliceGet
): Pick<
  TrelloSlice,
  'fetchTrelloBoards' | 'fetchTrelloLists' | 'fetchTrelloBoardMembers' | 'fetchTrelloBoardLabels'
> {
  return {
    fetchTrelloBoards: async () => {
      const cached = get().trelloBoardsCache
      if (cached !== null) {
        return cached
      }
      const gen = get().trelloCacheGeneration
      const boards = await trelloListBoards(get().settings)
      if (get().trelloCacheGeneration === gen) {
        set({ trelloBoardsCache: boards })
      }
      return boards
    },

    fetchTrelloLists: async (boardId) => {
      const cached = get().trelloListsCache[boardId]
      if (cached) {
        return cached
      }
      const gen = get().trelloCacheGeneration
      const lists = await trelloListLists(get().settings, boardId)
      if (get().trelloCacheGeneration === gen) {
        set((s) => ({
          trelloListsCache: { ...s.trelloListsCache, [boardId]: lists }
        }))
      }
      return lists
    },

    fetchTrelloBoardMembers: async (boardId) => {
      const cached = get().trelloBoardMembersCache[boardId]
      if (cached) {
        return cached
      }
      const gen = get().trelloCacheGeneration
      const members = await trelloListBoardMembers(get().settings, boardId)
      if (get().trelloCacheGeneration === gen) {
        set((s) => ({
          trelloBoardMembersCache: { ...s.trelloBoardMembersCache, [boardId]: members }
        }))
      }
      return members
    },

    fetchTrelloBoardLabels: async (boardId) => {
      const cached = get().trelloBoardLabelsCache[boardId]
      if (cached) {
        return cached
      }
      const gen = get().trelloCacheGeneration
      const labels = await trelloListBoardLabels(get().settings, boardId)
      if (get().trelloCacheGeneration === gen) {
        set((s) => ({
          trelloBoardLabelsCache: { ...s.trelloBoardLabelsCache, [boardId]: labels }
        }))
      }
      return labels
    }
  }
}
