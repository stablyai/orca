export const ADD_PROJECT_MENU_ATTRIBUTE = 'data-add-project-menu'

export function isWithinAddProjectMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${ADD_PROJECT_MENU_ATTRIBUTE}]`) !== null
}
