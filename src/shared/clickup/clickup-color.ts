const HEX_COLOR = /^#[0-9a-f]{3,8}$/i

/** ClickUp colors are external text; only a plain hex value may reach a style. */
export function safeClickUpColor(color: string | undefined): string | undefined {
  return color && HEX_COLOR.test(color) ? color : undefined
}
