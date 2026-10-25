// Why: xterm exposes no public cell-size API, so rendering specs read the private render
// service's CSS cell dimensions; every level is optional so each read stays guarded.
export type XtermWithRenderDimensions = {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } }
    }
  }
}
