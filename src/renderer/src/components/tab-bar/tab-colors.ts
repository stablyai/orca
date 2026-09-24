export type TabColorOption = {
  label: string
  value: string | null
}

export const PRESET_TAB_COLORS: TabColorOption[] = [
  { label: '無 (None)', value: null },
  { label: '藍色 (Blue)', value: '#3b82f6' },
  { label: '紫色 (Purple)', value: '#a855f7' },
  { label: '粉紅 (Pink)', value: '#ec4899' },
  { label: '紅色 (Red)', value: '#ef4444' },
  { label: '橙色 (Orange)', value: '#f97316' },
  { label: '琥珀 (Amber)', value: '#f59e0b' },
  { label: '黃色 (Yellow)', value: '#eab308' },
  { label: '綠色 (Green)', value: '#22c55e' },
  { label: '翡翠 (Emerald)', value: '#10b981' },
  { label: '青色 (Teal)', value: '#14b8a6' },
  { label: '天藍 (Cyan)', value: '#06b6d4' },
  { label: '靛青 (Indigo)', value: '#6366f1' },
  { label: '灰色 (Gray)', value: '#9ca3af' }
]
