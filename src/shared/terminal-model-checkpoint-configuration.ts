import type { IImageAddonOptions } from '@xterm/addon-image'
import type { IImageColors } from '@xterm/addon-image/src/ImageRasterBackend'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX
} from './terminal-scrollback-policy'
import { buildInlineImageAddonOptions } from './terminal-inline-image-options'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'

export type HeadlessInlineImageConfiguration = {
  cellSize: { width: number; height: number }
  colors: IImageColors
  options?: Omit<IImageAddonOptions, 'rasterBackend'>
}

export type HeadlessModelConfiguration = {
  cols: number
  rows: number
  scrollback?: number
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
  images?: HeadlessInlineImageConfiguration
}

export function copyHeadlessModelConfiguration(
  opts: HeadlessModelConfiguration
): HeadlessModelConfiguration {
  return {
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback ?? DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    pathFlavor: opts.pathFlavor,
    remotePosixFileUriAuthority: opts.remotePosixFileUriAuthority,
    wslDistro: opts.wslDistro,
    images: opts.images ? structuredClone(opts.images) : undefined
  }
}

export function validateModelCheckpointConfiguration(
  configuration: HeadlessModelConfiguration
): void {
  const { images, scrollback = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } = configuration
  if (
    !isValidTerminalHistorySize(configuration.cols, configuration.rows) ||
    !Number.isSafeInteger(scrollback) ||
    scrollback < 0 ||
    scrollback > DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX ||
    !images ||
    !Number.isFinite(images.cellSize.width) ||
    images.cellSize.width <= 0 ||
    !Number.isFinite(images.cellSize.height) ||
    images.cellSize.height <= 0
  ) {
    throw new Error('Invalid complete terminal checkpoint configuration')
  }
  const colors = [images.colors.foreground, images.colors.background, ...images.colors.ansi]
  if (
    images.colors.ansi.length > 256 ||
    colors.some(
      (color) => !Number.isSafeInteger(color.rgba) || color.rgba < 0 || color.rgba > 0xffffffff
    )
  ) {
    throw new Error('Invalid complete terminal checkpoint colors')
  }
  const options = images.options ?? {}
  const defaults = buildInlineImageAddonOptions()
  for (const key of ['pixelLimit', 'sixelSizeLimit', 'iipSizeLimit', 'kittySizeLimit'] as const) {
    const value = options[key]
    const ceiling = defaults[key]
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || ceiling === undefined || value > ceiling)
    ) {
      throw new Error('Invalid complete terminal checkpoint image limits')
    }
  }
  if (
    (options.storageLimit !== undefined &&
      (!Number.isFinite(options.storageLimit) ||
        options.storageLimit < 0.5 ||
        options.storageLimit > 1000)) ||
    (options.sixelPaletteLimit !== undefined &&
      (!Number.isSafeInteger(options.sixelPaletteLimit) ||
        options.sixelPaletteLimit < 1 ||
        options.sixelPaletteLimit > 4096))
  ) {
    throw new Error('Invalid complete terminal checkpoint image options')
  }
  for (const key of [
    'enableSizeReports',
    'showPlaceholder',
    'sixelSupport',
    'sixelScrolling',
    'iipSupport',
    'kittySupport'
  ] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new Error('Invalid complete terminal checkpoint image options')
    }
  }
}
