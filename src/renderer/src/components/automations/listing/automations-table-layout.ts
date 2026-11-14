// Name (+ schedule) | Project | [Host] | Next run | Last run | Actions
const AUTOMATIONS_TABLE_GRID_CLASS =
  'grid grid-cols-[minmax(14rem,1fr)_minmax(6rem,9rem)_minmax(7.5rem,10rem)_minmax(7.5rem,10rem)_2.5rem]'
const AUTOMATIONS_TABLE_GRID_WITH_HOST_CLASS =
  'grid grid-cols-[minmax(14rem,1fr)_minmax(6rem,9rem)_minmax(5rem,8rem)_minmax(7.5rem,10rem)_minmax(7.5rem,10rem)_2.5rem]'

/** The Host column appears only when the list spans more than one host. */
export function automationsTableGridClass(showHost: boolean): string {
  return showHost ? AUTOMATIONS_TABLE_GRID_WITH_HOST_CLASS : AUTOMATIONS_TABLE_GRID_CLASS
}
