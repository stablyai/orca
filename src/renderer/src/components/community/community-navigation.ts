import { create } from 'zustand'
import { useAppStore } from '@/store'
import type { CommunityQuery } from '../../../../shared/community-operations'
type CommunitySection = 'proposals' | 'activity' | 'changelog' | 'custom'
export const useCommunityNavigation = create<{
  section: CommunitySection
  query: CommunityQuery
  number: number | null
  setSection: (section: CommunitySection) => void
  setQuery: (query: CommunityQuery) => void
  open: (number: number | null) => void
}>((set) => ({
  section: 'proposals',
  query: { view: 'explore', limit: 12 },
  number: null,
  setSection: (section) => set({ section, number: null }),
  setQuery: (query) => set({ query: { ...query, offset: 0 } }),
  open: (number) => set({ number })
}))
export function openCommunity(section: CommunitySection = 'proposals'): void {
  useCommunityNavigation.getState().setSection(section)
  const store = useAppStore.getState()
  store.recordViewVisit('community')
  store.setActiveView('community')
}
