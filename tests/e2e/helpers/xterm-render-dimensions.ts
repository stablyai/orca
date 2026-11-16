// xterm has no public cell-size API; guard every optional level of the private render-service dimensions.
export type XtermWithRenderDimensions = {
  _core?: {
    _renderService?: {
      dimensions?: { css?: { cell?: { width: number; height: number } } }
    }
  }
}
