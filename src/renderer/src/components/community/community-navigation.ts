import { create } from 'zustand'
import { useAppStore } from '@/store'
import type { CommunityQuery } from '../../../../shared/community-operations'
type CommunitySection = 'proposals' | 'activity' | 'changelog' | 'custom'
export const useCommunityNavigation = create<{
  section: CommunitySection
  query: CommunityQuery
  number: number | null
  installedQuery: string
  installedImagesOnly: boolean
  installedChangeId: string | null
  setInstalledQuery: (installedQuery: string) => void
  setInstalledImagesOnly: (installedImagesOnly: boolean) => void
  openInstalled: (installedChangeId: string | null) => void
  setSection: (section: CommunitySection) => void
  setQuery: (query: CommunityQuery) => void
  open: (number: number | null) => void
}>((set) => ({
  section: 'proposals',
  query: { view: 'explore', limit: 12 },
  number: null,
  installedQuery: '',
  installedImagesOnly: false,
  installedChangeId: null,
  setInstalledQuery: (installedQuery) => set({ installedQuery }),
  setInstalledImagesOnly: (installedImagesOnly) => set({ installedImagesOnly }),
  openInstalled: (installedChangeId) => set({ installedChangeId }),
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
