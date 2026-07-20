export type MediaPlaybackPlayer = 'spotify' | 'apple-music'

export type MediaPlaybackState = 'playing' | 'paused' | 'stopped'

export type MediaPlaybackStatus = {
  player: MediaPlaybackPlayer
  state: MediaPlaybackState
  artist: string
  track: string
}
