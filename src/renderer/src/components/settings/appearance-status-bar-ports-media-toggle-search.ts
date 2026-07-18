import type { StatusBarItem } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

type StatusBarToggleSearchEntry = {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}

export function getPortsToggleEntry(): StatusBarToggleSearchEntry {
  return {
    id: 'ports',
    title: translate('auto.components.settings.appearance.search.cf409b6c4d', 'Ports'),
    description: translate(
      'auto.components.settings.appearance.search.0ececfa190',
      'Show live workspace ports in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.006e67b279', 'ports'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.46d21eef62',
        'localhost'
      ),
      ...translateSearchKeyword('auto.components.settings.appearance.search.43cfba3b95', 'server'),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.dc02c8759d',
        'workspace'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.portsToggleDescription',
      'Show live workspace ports. Click it for workspace-scoped ports and external listeners.'
    )
  }
}

export function getMediaPlaybackToggleEntry(): StatusBarToggleSearchEntry {
  return {
    id: 'media-playback',
    title: translate('settings.appearance.statusBar.mediaPlayback', 'Now Playing'),
    description: translate(
      'settings.appearance.statusBar.mediaPlaybackDescription',
      'Show the current Apple Music or Spotify track in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.896eb53fd4',
        'status bar'
      ),
      ...translateSearchKeyword('settings.appearance.statusBar.mediaPlayback.music', 'music'),
      ...translateSearchKeyword('settings.appearance.statusBar.mediaPlayback.spotify', 'spotify'),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.mediaPlayback.appleMusic',
        'apple music'
      ),
      ...translateSearchKeyword(
        'settings.appearance.statusBar.mediaPlayback.nowPlaying',
        'now playing'
      )
    ],
    toggleDescription: translate(
      'settings.appearance.statusBar.mediaPlaybackToggleDescription',
      'Show the active local Apple Music or Spotify track on macOS.'
    )
  }
}
