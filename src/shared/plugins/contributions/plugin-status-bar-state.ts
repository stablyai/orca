import type { PluginStatusBarItemPatch } from './plugin-status-bar-item-contribution'

/** Runtime changes workers made, by plugin key then item id; main pushes it to the renderer. */
export type PluginStatusBarOverrides = Readonly<
  Record<string, Readonly<Record<string, PluginStatusBarItemPatch>>>
>

/** main → renderer: a new PluginStatusBarOverrides snapshot. */
export const PLUGIN_STATUS_BAR_CHANGED_CHANNEL = 'plugins:statusBarChanged'
