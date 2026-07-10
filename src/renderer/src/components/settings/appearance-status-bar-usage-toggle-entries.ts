// Why: both Antigravity and Grok PR stacks once owned a full usage-toggle
// catalog. Keep this path as a re-export of the single consolidated module so
// old imports do not silently serve an incomplete provider list.
export {
  getUsageStatusBarToggles as getUsageStatusBarToggleEntries,
  type StatusBarToggleSearchEntry
} from './appearance-status-bar-usage-toggles'
